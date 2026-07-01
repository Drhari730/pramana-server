const fs = require('fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('public/index.html', 'utf8');

const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost' });
const window = dom.window;

// Mock BK and ST
window.BK = { isServer: () => false, members: [] };
window.ST = {
  project: { question: 'Yes' },
  refs: [{ id: '1', title: 'Test', dup: false, ta: { final: 'include' } }],
  settings: {},
  agent: {},
  engine: null,
  team: [],
  effects: [],
  grade: []
};

try {
  window.ASRMA.go('screen');
  console.log('Success!');
} catch(e) {
  console.error('Error during ASRMA.go(screen):', e);
}
