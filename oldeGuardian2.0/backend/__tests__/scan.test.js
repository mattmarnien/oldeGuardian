const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanGrouped } = require('..');

describe('scanGrouped', () => {
  const tmpDir = path.join(os.tmpdir(), `og-test-${Date.now()}`);
  const musicDir = path.join(tmpDir, 'music');
  const sfxDir = path.join(tmpDir, 'soundEffects');

  beforeAll(() => {
    fs.mkdirSync(musicDir, { recursive: true });
    fs.mkdirSync(sfxDir, { recursive: true });
    // root file
    fs.writeFileSync(path.join(musicDir, 'root.mp3'), '');
    // subfolder
    fs.mkdirSync(path.join(musicDir, 'battle'));
    fs.writeFileSync(path.join(musicDir, 'battle', 'b1.opus'), '');
    // sfx subfolder
    fs.mkdirSync(path.join(sfxDir, 'human'));
    fs.writeFileSync(path.join(sfxDir, 'human', 'h1.wav'), '');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('groups music and sfx one level deep', () => {
    // call the function directly by constructing the absolute path
    const scan = require('..').scanGrouped;
    const mg = scan(musicDir);
    expect(mg.root).toBeDefined();
    expect(Array.isArray(mg.battle)).toBeTruthy();
    const sg = scan(sfxDir);
    expect(Array.isArray(sg.human)).toBeTruthy();
  });
});
