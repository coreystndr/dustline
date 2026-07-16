// Load release info from GitHub first, fall back to /updates/latest.json

const GH_API = 'https://api.github.com/repos/coreystndr/dustline/releases/latest';
const GH_LATEST_JSON = 'https://github.com/coreystndr/dustline/releases/latest/download/latest.json';
const LOCAL_MANIFEST = '/updates/latest.json';

function setDownloadHref(version, directUrl) {
  const exe =
    directUrl ||
    `https://github.com/coreystndr/dustline/releases/latest/download/DUSTLINE_${version}_x64-setup.exe`;
  const a1 = document.getElementById('btnDownload');
  const a2 = document.getElementById('btnDownload2');
  const ver = document.getElementById('dlVersion');
  if (a1) {
    a1.href = exe;
    a1.removeAttribute('download'); // cross-origin GitHub
  }
  if (a2) {
    a2.href = exe;
    a2.removeAttribute('download');
  }
  if (ver) ver.textContent = `Installer · v${version}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function loadManifest() {
  // 1) GitHub release asset latest.json (source of truth after CI release)
  try {
    return await fetchJson(GH_LATEST_JSON);
  } catch (_) {
    /* fall through */
  }
  // 2) GitHub API for assets
  try {
    const rel = await fetchJson(GH_API);
    const version = (rel.tag_name || 'v1.0.0').replace(/^v/, '');
    const setup = (rel.assets || []).find((a) => /setup\.exe$/i.test(a.name));
    const notes = rel.body || 'See GitHub release notes.';
    return {
      version,
      notes,
      pub_date: rel.published_at,
      installer_url: setup
        ? setup.browser_download_url
        : `https://github.com/coreystndr/dustline/releases/latest/download/DUSTLINE_${version}_x64-setup.exe`,
      platforms: {},
      _source: 'github-api',
    };
  } catch (_) {
    /* fall through */
  }
  // 3) Local Vercel mirror
  return fetchJson(LOCAL_MANIFEST);
}

async function boot() {
  const meta = document.getElementById('releaseMeta');
  const log = document.getElementById('changelog');
  try {
    const data = await loadManifest();
    const version = data.version || '1.0.0';
    const installer =
      data.installer_url ||
      `https://github.com/coreystndr/dustline/releases/latest/download/DUSTLINE_${version}_x64-setup.exe`;
    setDownloadHref(version, installer);

    if (meta) {
      meta.innerHTML = `Latest: <strong>v${version}</strong> · from GitHub Releases · <a href="https://github.com/coreystndr/dustline/releases" style="color:#d4622e">all releases</a>`;
    }

    if (log) {
      log.innerHTML = '';
      const entry = document.createElement('div');
      entry.className = 'entry';
      entry.innerHTML = `<div class="ver">v${version}</div><div class="notes"></div>`;
      entry.querySelector('.notes').textContent = data.notes || 'Initial release.';
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
      meta.innerHTML =
        'No release yet. After CI publishes a tag, downloads appear from <a href="https://github.com/coreystndr/dustline/releases" style="color:#d4622e">GitHub Releases</a>.';
    }
    if (log) {
      log.innerHTML =
        '<p class="muted">Waiting for first GitHub Release (workflow <code>Release</code>).</p>';
    }
    setDownloadHref('1.0.0', 'https://github.com/coreystndr/dustline/releases/latest');
    console.warn('manifest', e);
  }
}

boot();
