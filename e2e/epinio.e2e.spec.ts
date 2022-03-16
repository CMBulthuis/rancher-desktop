import fs from 'fs';
import os from 'os';
import path from 'path';
import { ElectronApplication, BrowserContext, _electron, Page } from 'playwright';
import { test, expect } from '@playwright/test';
import {
  createDefaultSettings, tearDownHelm, playwrightReportAssets, setUpHelmCustomEnv, helm, kubectl,
} from './utils/TestUtils';
import { NavPage } from './pages/nav-page';
import * as childProcess from '@/utils/childProcess';

let page: Page;

test.describe.serial('Epinio Install Test', () => {
  // Disabling this test for linux and windows - See https://github.com/rancher-sandbox/rancher-desktop/issues/1634
  test.skip(os.platform().startsWith('linux') || os.platform().startsWith('win'), 'Need further investigation on Linux runner');
  let electronApp: ElectronApplication;
  let context: BrowserContext;

  test.beforeAll(async() => {
    installEpinioCli();
    createDefaultSettings();
    setUpHelmCustomEnv();

    electronApp = await _electron.launch({
      args: [
        path.join(__dirname, '../'),
        '--disable-gpu',
        '--whitelisted-ips=',
        '--disable-dev-shm-usage',
      ]
    });
    context = electronApp.context();

    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await electronApp.firstWindow();
  });

  test.afterAll(tearDownEpinio);

  /**
   * helm teardown
   * It should run outside of the electronApp.close(), just to make sure the teardown won't
   * affect the shutdown process in case of exceptions/errors.
   */
  test.afterAll(tearDownHelm);

  test.afterAll(async() => {
    await context.tracing.stop({ path: playwrightReportAssets(path.basename(__filename)) });
    await electronApp.close();
  });

  test('should start loading the background services', async() => {
    const navPage = new NavPage(page);

    await navPage.progressBecomesReady();
    await expect(navPage.progressBar).toBeHidden();
  });
  test('should check kubernetes API is ready', async() => {
    const output = await kubectl('cluster-info');

    expect(output).toMatch(/is running at ./);
  });
  test('should verify epinio cli was properly installed', async() => {
    const epinioCliStatus = await epinio('version');

    expect(epinioCliStatus).toContain('Epinio Version');
  });
  test('should add epinio-installer helm repository', async() => {
    const epinioRepoAdd = await helm('repo', 'add', 'epinio', 'https://epinio.github.io/helm-charts');

    expect(epinioRepoAdd).toContain('"epinio" has been added to your repositories');
  });
  test('should install epinio-installer application', async() => {
    const loadBalancerIpAddr = await loadBalancerIp();
    const epinioInstall = await helm('install', 'epinio-installer', 'epinio/epinio-installer',
      '--set', 'skipTraefik=true', '--set', `domain=${ loadBalancerIpAddr }.omg.howdoi.website`,
      '--wait', '--timeout=25m');

    expect(epinioInstall).toContain('STATUS: deployed');
  });
  test('should update epinio config certs file', async() => {
    const epinioConfigUpdate = await epinio('config', 'update');

    expect(epinioConfigUpdate).toContain('Ok');
  });
  test('should push a sample app through epinio cli', async() => {
    const epinioPush = await epinio('push', '--name', 'sample', '--path', path.join(__dirname, 'assets', 'sample-app'));

    expect(epinioPush).toContain('App is online.');
  });
  test('should verify deployed sample application is reachable', async() => {
    const loadBalancerIpAddr = await loadBalancerIp();
    const urlAddr = `https://sample.${ loadBalancerIpAddr }.omg.howdoi.website`;
    // Trick to avoid error 60 (SSL Cert error), passing "--insecure" parameter
    const sampleApp = await curl('--fail', '--insecure', urlAddr);

    expect(sampleApp).toContain('PHP Version');
  });
});

/**
 * Helper to identify the Load Balancer IP Address.
 * It will return the traefik IP address, required by epinio install.
 */
export async function loadBalancerIp() {
  const serviceInfo = await kubectl('describe', 'service', 'traefik', '--namespace', 'kube-system');
  const serviceFiltered = serviceInfo.split('\n').toString();
  const m = /LoadBalancer Ingress:\s+(((?:[0-9]{1,3}\.){3}[0-9]{1,3}))/.exec(serviceFiltered);

  // checking if it will be undefined, null, 0 or empty
  if (m) {
    return m[1];
  } else {
    console.log('Cannot find load balancer IP address.');
  }
}

const platforms: Record<string, string> = { darwin: 'darwin', win32: 'win32', linux: 'linux' };

export async function installEpinioCli() {
  const platform = os.platform() as string;

  if (!platforms[platform]) {
    console.error(`Platform type not detect. Found: ${ platform }`);
  }

  // Download epinio binary based on platform type
  await downloadEpinioBinary(platform);
}

/**
 * Download epinio binary based on the platform type and save the binary
 * into a temporary folder.
 */
export async function downloadEpinioBinary( platformType: string) {
  // Setting up epinio binaries names per platform
  const epinioWin = 'epinio-windows-amd64.exe';
  const epinioLinux = 'epinio-linux-x86_64';
  const epinioDarwin = 'epinio-darwin-x86_64';
  const epinioDarwinArm = 'epinio-darwin-arm64';
  const epinioWorkingVersion = 'v0.5.0';

  // Create a temp folder for epinio binary
  const epinioTempFolder = path.join(os.homedir(), 'epinio-tmp');

  if (!fs.existsSync(epinioTempFolder)) {
    fs.mkdirSync(epinioTempFolder, { recursive: true });
  }

  // Detect CPU arch
  const cpuArch = os.arch();

  switch (platformType) {
  case 'darwin':
    if (cpuArch === 'x64') {
      await downloadEpinioCommand(epinioWorkingVersion, epinioDarwin, epinioTempFolder);
      break;
    } else {
      await downloadEpinioCommand(epinioWorkingVersion, epinioDarwinArm, epinioTempFolder);
      break;
    }
  case 'linux':
    await downloadEpinioCommand(epinioWorkingVersion, epinioLinux, epinioTempFolder);
    break;
  case 'win32':
    await downloadEpinioCommand(epinioWorkingVersion, epinioWin, epinioTempFolder);
    break;
  }
}

/**
 * Download latest epinio cli binary and makes it executable
 */
export async function downloadEpinioCommand(version: string, platform: string, folder: string) {
  const epinioUrl = 'https://github.com/epinio/epinio/releases/download/';

  if (!os.platform().startsWith('win')) {
    await curl('--fail', '--location', `${ epinioUrl }${ version }/${ platform }`, '--output', `${ folder }\/epinio`);
    const stat = fs.statSync(`${ folder }\/epinio`).mode;

    fs.chmodSync(`${ folder }\/epinio`, stat | 0o755);
  } else {
    const winPath = path.resolve(folder);
    await curl('--fail', '--location', `${ epinioUrl }${ version }/${ platform }`, '--output', `${ winPath }\\epinio.zip`);
    await unzip('-o', `${ winPath }\\epinio.zip`, 'epinio.exe', '-d', `${ folder }`);
  }
}

/**
 * Gracefully remove epinio temp folder and uninstall all epinio-install resources
 */
export async function tearDownEpinio() {
  const epinioTempFolder = path.join(os.homedir(), 'epinio-tmp');

  if (fs.existsSync(epinioTempFolder)) {
    fs.rmSync(epinioTempFolder, { recursive: true, maxRetries: 10 });
  }

  await helm('uninstall', 'epinio-installer', '--timeout=20m');
}

/**
 * Run the given tool with the given arguments, returning its standard output.
 */
export async function tool(tool: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await childProcess.spawnFile(
      tool, args, { stdio: ['ignore', 'pipe', 'inherit'] });

    return stdout;
  } catch (ex:any) {
    console.error(`Error running ${ tool } ${ args.join(' ') }`);
    console.error(`stdout: ${ ex.stdout }`);
    console.error(`stderr: ${ ex.stderr }`);
    throw ex;
  }
}

export async function curl(...args: string[] ): Promise<string> {
  return await tool('curl', ...args);
}

export async function unzip(...args: string[] ): Promise<string> {
  return await tool('unzip', ...args);
}

export async function epinio(...args: string[] ): Promise<string> {
  const epinioTmpDir = path.join(os.homedir(), 'epinio-tmp');
  const filename = os.platform().startsWith('win') ? 'epinio.exe' : 'epinio';
  const exec = path.join(epinioTmpDir, filename as string);

  return await tool(exec, ...args);
}
