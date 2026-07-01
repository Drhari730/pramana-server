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
window.PHASES = dom.window.PHASES;

const phases = ['protocol', 'agents', 'sources', 'import', 'dedup', 'screen', 'fulltext', 'extract', 'quality', 'synth', 'grade', 'report', 'viveka'];
for (const p of phases) {
  try {
    window.ASRMA.go(p);
    console.log('Success for phase:', p);
  } catch(e) {
    console.error('Error in phase:', p, e.message);
  }
}
