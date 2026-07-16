// Load latest.json and wire download buttons + changelog

const MANIFEST_URL = '/updates/latest.json';

function setDownloadHref(version, directUrl) {
  // Prefer installer path convention used by release script
  const exe = directUrl || `/downloads/DUSTLINE_${version}_x64-setup.exe`;
  const a1 = document.getElementById('btnDownload');
  const a2 = document.getElementById('btnDownload2');
  const ver = document.getElementById('dlVersion');
  if (a1) {
    a1.href = exe;
    a1.setAttribute('download', `DUSTLINE_${version}_x64-setup.exe`);
  }
  if (a2) {
    a2.href = exe;
    a2.setAttribute('download', `DUSTLINE_${version}_x64-setup.exe`);
  }
  if (ver) ver.textContent = `Installer · v${version}`;
}

async function boot() {
  const meta = document.getElementById('releaseMeta');
  const log = document.getElementById('changelog');
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const version = data.version || '1.0.0';
    // Prefer dedicated installer URL if set, else classic path
    const installer =
      data.installer_url ||
      `/downloads/DUSTLINE_${version}_x64-setup.exe`;
    setDownloadHref(version, installer);

    if (meta) {
      const platforms = data.platforms ? Object.keys(data.platforms).join(', ') : 'windows-x86_64';
      meta.textContent = `Latest: v${version} · ${platforms}${data.pub_date ? ` · ${data.pub_date.slice(0, 10)}` : ''}`;
    }

    if (log) {
      log.innerHTML = '';
      const entry = document.createElement('div');
      entry.className = 'entry';
      entry.innerHTML = `
        <div class="ver">v${version}</div>
        <div class="notes"></div>
      `;
      entry.querySelector('.notes').textContent = data.notes || 'Initial release.';
      log.appendChild(entry);

      // Optional history array
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
    if (meta) meta.textContent = 'Latest: publish a release to populate downloads.';
    if (log) log.innerHTML = '<p class="muted">No release notes yet. After your first publish, notes from latest.json appear here.</p>';
    setDownloadHref('1.0.0');
    console.warn('manifest', e);
  }
}

boot();
