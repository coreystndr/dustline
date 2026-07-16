const fs=require('fs');
const sig=fs.readFileSync('src-tauri/target/release/bundle/nsis/DUSTLINE_1.0.3_x64-setup.exe.sig','utf8').trim();
const notes='New main menu: tactical split layout, island backdrop, storm ring. Matchmaking + auto-update pipeline. steam_api64.dll included.';
const site='https://website-red-six-83.vercel.app';
const gh='https://github.com/coreystndr/dustline/releases/download/v1.0.3';
const setup='DUSTLINE_1.0.3_x64-setup.exe';
const latest={
  version:'1.0.3',
  notes,
  pub_date:new Date().toISOString(),
  installer_url:site+'/downloads/'+setup,
  platforms:{'windows-x86_64':{signature:sig,url:site+'/downloads/'+setup}},
  history:[
    {version:'1.0.2',notes:'Updater key UX'},
    {version:'1.0.1',notes:'Matchmaking fix'},
    {version:'1.0.0',notes:'Initial'}
  ]
};
fs.writeFileSync('website/public/updates/latest.json',JSON.stringify(latest,null,2)+'\n');
const g={...latest,installer_url:gh+'/'+setup,platforms:{'windows-x86_64':{signature:sig,url:gh+'/'+setup}}};
fs.writeFileSync('latest.json',JSON.stringify(g,null,2)+'\n');
console.log('manifests ok', latest.version);
