import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { analyse } from '../catalogue/src/detect';
import { canonicaliseSubjects } from '../catalogue/src/subjects';
import { getCatalogue } from '../src/lib/catalogue';

test('short boss identities retain full names and guide titles', () => {
  for (const [slug, title, filename] of [
    [
      'silverquill',
      'Silverquill, The Dreadhog',
      'afk-silverquill-the-dreadhog',
    ],
    ['ivar', 'Ivar, King of Bones', 'afk-ivar-king-of-bones'],
  ]) {
    const path = `afk/${filename}.txt`;
    const [guide] = canonicaliseSubjects([
      analyse(`# AFK ${title}\nBody`, path, '/guides'),
    ]);
    assert.equal(guide.subjectId, slug);
    assert.equal(guide.subject?.value, title);
    assert.equal(guide.title, `AFK ${title}`);
    assert.equal(guide.path, path);
  }
});

test('short boss routes and matching artwork are used throughout built hubs', () => {
  const catalogue = getCatalogue();
  const directory = readFileSync('dist/bosses/index.html', 'utf8');
  for (const [slug, oldSlug] of [
    ['silverquill', 'silverquill-dreadhog'],
    ['ivar', 'ivar-king-of-bones'],
  ]) {
    const boss = catalogue.bosses.find((boss) => boss.slug === slug);
    assert.ok(boss, slug);
    assert.ok(boss.guides.length);
    assert.ok(!catalogue.bosses.some((boss) => boss.slug === oldSlug));
    assert.ok(existsSync(`src/assets/bosses/${slug}.webp`));
    const hub = readFileSync(`dist/bosses/${slug}/index.html`, 'utf8');
    assert.ok(directory.includes(`/bosses/${slug}/`));
    assert.ok(hub.includes(`/_astro/${slug}.`));
    assert.ok(!(directory + hub).includes(`/bosses/${oldSlug}/`));
    assert.ok(!(directory + hub).includes(`/_astro/${oldSlug}.`));
  }
});

test('Vorkath encounter identity excludes instance modes while guide titles stay exact', () => {
  const modes = ['SM', 'NM', 'HM', 'Story Mode', 'Normal Mode', 'Hard Mode'];
  const titles = modes.map((mode) => `Zemouregal and Vorkath (${mode})`);
  const guides = canonicaliseSubjects([
    analyse(
      '# Low Effort Zemouregal and Vorkath (HM)\nBody',
      'afk/low-effort-vorkath.txt',
      '/guides',
    ),
    ...titles.map((title, index) =>
      analyse(
        `# ${title}\nBody`,
        `rs3-full-boss-guides/vorkath/mode-${index}.txt`,
        '/guides',
      ),
    ),
  ]);
  for (const guide of guides) {
    assert.equal(guide.subjectId, 'zemouregal-and-vorkath');
    assert.equal(guide.subject?.value, 'Zemouregal and Vorkath');
  }
  assert.deepEqual(
    guides.slice(1).map((guide) => guide.title),
    titles,
  );
});

test('built Vorkath hub, guide links and artwork use the mode-independent boss slug', () => {
  const catalogue = getCatalogue();
  const boss = catalogue.bosses.find(
    (boss) => boss.slug === 'zemouregal-and-vorkath',
  );
  assert.ok(boss);
  assert.match(boss.name, /^Zemouregal and Vorkath$/i);
  assert.ok(boss.guides.length >= 7);
  assert.ok(boss.guides.some((guide) => /Hard Mode|\(HM\)/.test(guide.title)));
  assert.ok(
    !catalogue.bosses.some((boss) => boss.slug === 'zemouregal-and-vorkath-hm'),
  );
  assert.ok(existsSync('src/assets/bosses/zemouregal-and-vorkath.webp'));
  const directory = readFileSync('dist/bosses/index.html', 'utf8');
  const hub = readFileSync(
    'dist/bosses/zemouregal-and-vorkath/index.html',
    'utf8',
  );
  assert.match(directory, /\/bosses\/zemouregal-and-vorkath\//);
  assert.match(hub, /\/_astro\/zemouregal-and-vorkath\./);
  assert.doesNotMatch(directory + hub, /\/bosses\/zemouregal-and-vorkath-hm\//);
  assert.doesNotMatch(directory + hub, /\/_astro\/zemouregal-and-vorkath-hm\./);
});
