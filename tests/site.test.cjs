const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts/site.js'), 'utf8');

function run(href) {
  const url = new URL(href);
  const result = { scripts: [], listeners: {} };
  const window = {
    location: { href, protocol: url.protocol, replace: value => { result.redirect = value; } },
    history: { state: { retained: true }, replaceState: (state, title, value) => { result.url = value; result.state = state; } }
  };
  const document = {
    title: 'Poortjie', referrer: 'https://poortjie.info/authentication/login?redirect=secret#private',
    head: { appendChild: script => result.scripts.push(script) },
    createElement: () => ({}),
    addEventListener: (name, callback) => { result.listeners[name] = callback; }
  };
  vm.runInNewContext(source, { window, document, URL });
  result.listeners.DOMContentLoaded?.();
  result.events = window.dataLayer?.map(args => Array.from(args)) || [];
  return result;
}

test('legacy URLs become clean without losing query, hash or history state', () => {
  const result = run('https://poortjie.info/authentication/profile.html?action=set-password#form');
  assert.equal(result.url, 'https://poortjie.info/authentication/profile?action=set-password#form');
  assert.equal(result.state.retained, true);
});
test('directory index URLs keep the trailing slash needed by relative assets', () => {
  assert.equal(run('https://poortjie.info/laynfleet/laynrider/index.html').url, 'https://poortjie.info/laynfleet/laynrider/');
});
test('www redirects to canonical domain without recording a duplicate view', () => {
  const result = run('https://www.poortjie.info/market.html?item=1#details');
  assert.equal(result.redirect, 'https://poortjie.info/market?item=1#details');
  assert.equal(result.events.length, 0);
});
test('one page view excludes query and fragment data and disables automatic view', () => {
  const result = run('https://poortjie.info/market.html?item=secret#private');
  const views = result.events.filter(event => event[1] === 'page_view');
  assert.equal(views.length, 1);
  assert.equal(views[0][2].page_location, 'https://poortjie.info/market');
  assert.equal(views[0][2].page_referrer, 'https://poortjie.info/authentication/login');
  assert.equal(result.events.find(event => event[0] === 'config')[2].send_page_view, false);
  assert.equal(result.scripts.length, 1);
});
test('local previews do not send production analytics', () => {
  assert.equal(run('http://localhost:8080/home.html').events.length, 0);
  assert.equal(run('file:///tmp/home.html').events.length, 0);
});

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.name.startsWith('.') ? [] :
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
test('every full content page loads shared analytics exactly once; redirects and fragment do not', () => {
  for (const file of files(root).filter(file => file.endsWith('.html'))) {
    const html = fs.readFileSync(file, 'utf8');
    const redirectOrFragment = !/<head>/i.test(html) || /http-equiv="refresh"/i.test(html);
    assert.equal((html.match(/src="\/scripts\/site.js"/g) || []).length, redirectOrFragment ? 0 : 1, file);
    assert.ok(!html.includes('firebase-analytics-compat.js'), file);
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc=|application\/ld\+json|type="module"/.test(match[1])) new vm.Script(match[2], { filename: file });
    }
  }
});
