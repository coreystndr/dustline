// Download always comes from this site (absolute URL for reliability).

const SITE = 'https://website-red-six-83.vercel.app';
const LOCAL_INSTALLER = `${SITE}/downloads/DUSTLINE_1.0.0_x64-setup.exe`;
const LOCAL_MANIFEST = '/updates/latest.json';

function installerPathFor(version) {
  const v = (version || '1.0.0').replace(/^v/, '');
  return `${SITE}/downloads/DUSTLINE_${v}_x64-setup.exe`;
}

function normalizeInstallerUrl(url, version) {
  if (!url) return installerPathFor(version);
  // Relative path → absolute on this site
  if (url.startsWith('/')) return `${SITE}${url}`;
  // Never send users to empty GitHub Releases pages
  if (/github\.com\/.*\/releases(\/|$)/i.test(url) && !/\.exe(\?|$)/i.test(url)) {
    return installerPathFor(version);
  }
  return url;
}

function setDownloadHref(version, directUrl) {
  const url = normalizeInstallerUrl(directUrl, version);
  const a1 = document.getElementById('btnDownload');
  const a2 = document.getElementById('btnDownload2');
  const ver = document.getElementById('dlVersion');
  if (a1) {
    a1.href = url;
    a1.setAttribute('download', '');
  }
  if (a2) {
    a2.href = url;
    a2.setAttribute('download', '');
  }
  if (ver) {
    const v = (version || '1.0.0').replace(/^v/, '');
    ver.textContent = `Installer · v${v}`;
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function boot() {
  const meta = document.getElementById('releaseMeta');
  const log = document.getElementById('changelog');

  setDownloadHref('1.0.0', LOCAL_INSTALLER);

  try {
    const data = await fetchJson(LOCAL_MANIFEST);
    const version = (data.version || '1.0.0').replace(/^v/, '');
    const installer = data.installer_url || installerPathFor(version);
    setDownloadHref(version, installer);

    if (meta) {
      meta.innerHTML = `Latest: <strong>v${version}</strong> · direct download from this site`;
    }

    if (log) {
      log.innerHTML = '';
      const entry = document.createElement('div');
      entry.className = 'entry';
      entry.innerHTML = `<div class="ver">v${version}</div><div class="notes"></div>`;
      entry.querySelector('.notes').textContent =
        data.notes || 'Windows installer with Steam runtime (steam_api64.dll).';
      log.appendChild(entry);
      if (Array.isArray(data.history)) {
        for (const h of data.history) {
          const el = document.createElement('div');
          el.className = 'entry';
          el.innerHTML = `<div class="ver">v${h.version}</div><div class="notes"></div>`;
          el.querySelector('.notes').textContent = h.notes || '';
          log.appendChild(el);
        }
      }
    }
  } catch (e) {
    if (meta) {
      meta.innerHTML = `Latest: <strong>v1.0.0</strong> · <a href="${LOCAL_INSTALLER}">download installer</a>`;
    }
    if (log) {
      log.innerHTML =
        '<p class="muted">v1.0.0 — Windows installer (includes steam_api64.dll).</p>';
    }
    setDownloadHref('1.0.0', LOCAL_INSTALLER);
    console.warn('manifest', e);
  }
}

boot();
