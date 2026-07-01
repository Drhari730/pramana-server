const fs = require('fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('public/index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost' });
const window = dom.window;

setTimeout(async () => {
  window.BK.api = async () => ({ project: { data: { project: { question: 'Yes' }, refs: [{ id: '1', title: 'Test', dup: false, ta: { final: 'include' } }], settings: { screenMode: 'local' } } }, role: 'owner' });
  window.BK.members = [];
  try {
    await window.serverOpenProject('123');
    console.log('Success for serverOpenProject!');
  } catch(e) {
    console.error('Error in serverOpenProject:', e.stack);
  }
}, 500);
