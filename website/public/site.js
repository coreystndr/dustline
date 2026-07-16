// Download always from this site. Version comes from /updates/latest.json.

const SITE = 'https://website-red-six-83.vercel.app';
const LOCAL_MANIFEST = '/updates/latest.json';

function installerPathFor(version) {
  const v = (version || '1.0.3').replace(/^v/, '');
  return `${SITE}/downloads/DUSTLINE_${v}_x64-setup.exe`;
}

function normalizeInstallerUrl(url, version) {
  if (!url) return installerPathFor(version);
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
  if (ver) ver.textContent = `v${(version || '1.0.3').replace(/^v/, '')}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function boot() {
  const meta = document.getElementById('releaseMeta');
  const log = document.getElementById('changelog');
  const fallback = installerPathFor('1.0.3');
  setDownloadHref('1.0.3', fallback);

  try {
    const data = await fetchJson(LOCAL_MANIFEST);
    const version = (data.version || '1.0.3').replace(/^v/, '');
    const installer = data.installer_url || installerPathFor(version);
    setDownloadHref(version, installer);

    if (meta) {
      meta.innerHTML = `Latest: <strong>v${version}</strong> Â· auto-updates enabled`;
    }

    if (log) {
      log.innerHTML = '';
      const entry = document.createElement('div');
      entry.className = 'entry';
      entry.innerHTML = `<div class="ver">v${version}</div><div class="notes"></div>`;
      entry.querySelector('.notes').textContent =
        data.notes || 'Windows installer with Steam runtime + auto-updater.';
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
      meta.innerHTML = `Latest: <strong>v1.0.3</strong> Â· <a href="${fallback}">download installer</a>`;
    }
    if (log) {
      log.innerHTML = '<p class="muted">v1.0.3 â€” Windows installer (auto-updates).</p>';
    }
    setDownloadHref('1.0.3', fallback);
    console.warn('manifest', e);
  }
}

boot();
