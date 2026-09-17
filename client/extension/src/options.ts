/**
 * The options page: where descriptors are decided on.
 *
 * It is an extension page on purpose. The in-page panel sits in a page that
 * can overlay or clickjack it, so it only ever *mentions* an update; adopting
 * one, replacing a built-in, and granting a site all happen here, where the
 * page cannot reach. `permissions.request` also needs a user gesture on an
 * extension surface, which this is.
 *
 * Every rule is in client/core (manage.ts, adoption.ts); this file renders
 * state and turns clicks into those transitions. Text from a descriptor or a
 * server is attacker-controlled and only ever goes in via `textContent`.
 */
import {
  buildRegistry, openOffers, parseIndex, pendingUpdates, readState, serverOrigin, STORE_KEYS, writeState,
} from '@videosync/core/providers/adoption.ts';
import type { FieldChange, IndexEntry, ProviderState } from '@videosync/core/providers/adoption.ts';
import { parseDescriptor } from '@videosync/core/providers/descriptor.ts';
import type { Descriptor } from '@videosync/core/providers/descriptor.ts';
import {
  adopt, currentFor, decline, grantedBy, originsFor, removeUser, saveUser, setAutoAdopt, unadopt,
} from '@videosync/core/providers/manage.ts';
import type { Entry } from '@videosync/core/providers/registry.ts';

import type { AuthResponse } from '@videosync/core/app/authfetch.ts';

import { sitesGranted } from './grants.ts';
import { ask, authCall } from './relay.ts';
import type { SyncReply } from './relay.ts';

const PREFIX = 'videosync.';
const TIER: Record<string, string> = { 'built-in': '내장', server: '서버', user: '내가 추가' };

// ---------------------------------------------------------------------------
// Storage

async function loadAll(): Promise<{ state: ProviderState; server: string }> {
  const keys = [...Object.values(STORE_KEYS), 'server'].map((k) => PREFIX + k);
  const got = await chrome.storage.local.get(keys);
  const load = (k: string, fb = '') => {
    const v = got[PREFIX + k];
    return typeof v === 'string' ? v : fb;
  };
  return { state: readState(load), server: load('server') };
}

async function saveState(s: ProviderState): Promise<void> {
  const out: Record<string, string> = {};
  writeState((k, v) => { out[PREFIX + k] = v; }, s);
  await chrome.storage.local.set(out);
  // The worker also follows storage changes; asking directly surfaces an error.
  const r = await ask<SyncReply>({ t: 'providers.sync' }, (why) => ({ patterns: [], error: why }));
  if (r.error) status(`사이트 등록을 갱신하지 못했어요: ${r.error}`, 'warn');
}

// ---------------------------------------------------------------------------
// DOM helpers: createElement and textContent only.

type Kids = Array<Node | string | null | undefined | false>;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Partial<Record<string, string | boolean | ((e: Event) => void)>> = {}, ...kids: Kids
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (typeof v === 'boolean') (el as unknown as Record<string, boolean>)[k] = v;
    else if (v !== undefined) el.setAttribute(k, v);
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const app = document.getElementById('app')!;
const statusEl = h('div', { class: 'status', role: 'status' });

function status(text: string, level: '' | 'ok' | 'warn' | 'err' = ''): void {
  statusEl.className = `status ${level}`;
  statusEl.textContent = text;
}

const short = (sha: string) => sha.slice(0, 12);

function show(v: unknown): string {
  return v === undefined ? '(없음)' : JSON.stringify(v, null, 1);
}

function diffTable(changes: readonly FieldChange[]): HTMLElement {
  if (!changes.length) return h('p', { class: 'muted' }, '달라지는 내용이 없어요.');
  return h('table', { class: 'diff' },
    h('thead', {}, h('tr', {}, h('th', {}, '항목'), h('th', {}, '지금'), h('th', {}, '바뀐 뒤'))),
    h('tbody', {}, ...changes.map((c) => h('tr', { class: c.widens ? 'widens' : '' },
      h('th', {}, c.field, c.widens ? ' — 넓어짐' : ''),
      h('td', {}, show(c.before)),
      h('td', {}, show(c.after))))));
}

// ---------------------------------------------------------------------------

let state: ProviderState = { user: [], adopted: [], servers: {} };
let serverUrl = '';
let origins: string[] = [];
let index: IndexEntry[] | null = null;
/** An id whose server copy is shown for review, with the difference. */
let reviewing: { entry: IndexEntry; body: string; changes: FieldChange[]; replace: boolean } | null = null;
let draft = '';
let draftCheck: { changes: FieldChange[]; replaces: boolean } | null = null;

async function refreshOrigins(): Promise<void> {
  try {
    origins = (await chrome.permissions.getAll()).origins ?? [];
  } catch {
    origins = [];
  }
}

/**
 * Ask for a descriptor's sites. Called first thing in a click handler: the
 * browser only shows the prompt for a user gesture.
 */
function requestSites(d: Descriptor): void {
  const want = originsFor(d);
  chrome.permissions.request({ origins: want }).then(async (ok) => {
    await refreshOrigins();
    await ask<SyncReply>({ t: 'providers.sync' }, { patterns: [] });
    status(ok ? `${d.name}: 사이트 권한을 허용했어요.` : `${d.name}: 사이트 권한이 허용되지 않았어요.`, ok ? 'ok' : 'warn');
    render();
  }, (e) => status(`권한 요청 실패: ${String(e)}`, 'err'));
}

function entryCard(e: Entry): HTMLElement {
  const d = e.provider.d;
  const granted = grantedBy(origins);
  const allGranted = sitesGranted(d, granted);
  const needsGrant = e.tier !== 'built-in' && !allGranted;
  return h('div', { class: 'card' },
    h('h3', {},
      h('span', {}, d.name),
      h('code', {}, d.id),
      h('span', { class: 'tag' }, TIER[e.tier] ?? e.tier),
      h('span', { class: 'tag' }, `v${d.version}`),
      h('span', { class: 'tag', title: e.sha256 }, `sha256 ${short(e.sha256)}`),
      e.tier !== 'built-in' && h('span', { class: `tag ${allGranted ? 'ok' : 'warn'}` },
        allGranted ? '사이트 권한 있음' : '사이트 권한 필요')),
    h('div', { class: 'hosts' }, `주소: ${d.hosts.join(', ')}`,
      d.pageHosts ? ` · 실행 페이지: ${d.pageHosts.join(', ')}` : ''),
    h('div', { class: 'row' },
      needsGrant && h('button', { class: 'primary', onclick: () => requestSites(d) }, '사이트 권한 허용'),
      e.tier === 'user' && h('button', {
        onclick: () => {
          const u = state.user.find((x) => { const r = parseDescriptor(x.source); return r.ok && r.provider.id === d.id; });
          draft = u?.source ?? JSON.stringify(d, null, 2);
          draftCheck = null;
          render();
          document.getElementById('draft')?.scrollIntoView();
        },
      }, '편집'),
      e.tier === 'user' && h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm(`${d.name} 설명을 지울까요?`)) return;
          state = removeUser(state, d.id);
          await saveState(state);
          status(`${d.name} 설명을 지웠어요. 열려 있는 페이지는 새로고침하면 반영돼요.`, 'ok');
          render();
        },
      }, '삭제'),
      e.tier === 'server' && h('button', {
        class: 'danger',
        onclick: async () => {
          state = unadopt(state, d.id);
          await saveState(state);
          status(`${d.name}: 서버 설명을 더 이상 쓰지 않아요.`, 'ok');
          render();
        },
      }, '사용 중지')));
}

function effectiveSection(): HTMLElement {
  const reg = buildRegistry(state, grantedBy(origins));
  return h('section', {},
    h('h2', {}, '지금 쓰는 설명'),
    h('p', { class: 'muted' }, '같은 id면 내가 추가한 것 > 서버에서 받은 것 > 내장 순으로 쓰여요. ' +
      '내장이 아닌 설명은 사이트 권한을 허용한 곳에서만 방이 멤버를 데려갈 수 있어요.'),
    ...reg.entries.map(entryCard),
    reg.notes.length ? h('div', { class: 'card' }, h('h3', {}, '적용하지 않은 것'),
      ...reg.notes.map((n) => h('div', { class: 'muted' }, n))) : null);
}

function draftSection(): HTMLElement {
  const area = h('textarea', { id: 'draft', spellcheck: 'false', placeholder: '{ "schema": 1, "id": "...", ... }' });
  area.value = draft;
  area.addEventListener('input', () => { draft = area.value; draftCheck = null; saveBtn.disabled = true; });
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    draft = await f.text();
    draftCheck = null;
    render();
  });
  const saveBtn = h('button', {
    class: 'primary',
    disabled: !draftCheck,
    onclick: async () => {
      const r = await saveUser(state, draft);
      if (!r.ok) { status(r.error, 'err'); return; }
      state = r.state;
      await saveState(state);
      draft = '';
      draftCheck = null;
      status(`${r.descriptor.name} 설명을 저장했어요. 사이트 권한을 허용하고, 열려 있는 페이지는 새로고침하세요.`, 'ok');
      render();
    },
  }, draftCheck?.replaces ? '차이를 확인했어요 — 저장' : '저장');
  return h('section', {},
    h('h2', {}, '내 설명 추가·편집'),
    h('p', { class: 'muted' }, '붙여 넣거나 파일로 가져오세요. 저장하기 전에 형식과 파일 안의 examples를 검사해요.'),
    area,
    h('div', { class: 'row' },
      file,
      h('button', {
        onclick: async () => {
          const r = await saveUser(state, draft);
          if (!r.ok) { draftCheck = null; status(`쓸 수 없는 설명이에요:\n${r.error}`, 'err'); render(); return; }
          const displaces = r.displaces ?? [];
          const replaces = currentFor(state, r.descriptor.id) !== null || displaces.length > 0;
          draftCheck = { changes: r.changes, replaces };
          status(replaces
            ? `${r.descriptor.name}(${r.descriptor.id})${displaces.length ? `이(가) 내장된 ${displaces.join(', ')} 설명의 사이트를 대신하게` : '를 바꾸게'} 돼요. 아래 차이를 확인하세요.`
            : `${r.descriptor.name}: 새 설명이에요. 저장할 수 있어요.`, replaces ? 'warn' : 'ok');
          render();
        },
      }, '검사'),
      saveBtn),
    draftCheck ? diffTable(draftCheck.changes) : null);
}

/** Through the worker's one HTTP policy, as the content script does. */
async function fetchFromServer(path: '/api/providers' | `/api/providers/${string}.json`): Promise<AuthResponse & { ok: boolean }> {
  const r = await authCall(serverUrl, path, { method: 'GET' });
  const ok = r.status === 200 && !r.gateway;
  const why = r.status === 401 && !r.gateway ? '이 서버는 로그인이 필요해요. 방에 들어갈 때 로그인한 뒤 다시 시도하세요.' : r.error;
  return { ...r, ok, ...(why !== undefined ? { error: why } : {}) };
}

async function loadIndex(): Promise<void> {
  if (!serverOrigin(serverUrl)) { status('서버 주소를 입력하세요.', 'err'); return; }
  status('서버 목록을 불러오는 중…');
  const r = await fetchFromServer('/api/providers');
  if (!r.ok) { index = null; status(`목록을 받지 못했어요: ${r.error ?? `HTTP ${r.status}`}`, 'err'); render(); return; }
  index = parseIndex(r.body);
  status(`${index.length}개를 받았어요.`, 'ok');
  render();
}

async function review(entry: IndexEntry): Promise<void> {
  const r = await fetchFromServer(`/api/providers/${entry.id}.json`);
  if (!r.ok) { status(`파일을 받지 못했어요: ${r.error ?? `HTTP ${r.status}`}`, 'err'); return; }
  const parsed = parseDescriptor(r.body);
  if (!parsed.ok) { status(`서버의 설명을 쓸 수 없어요:\n${parsed.errors.join('\n')}`, 'err'); return; }
  const out = await adopt(state, serverUrl, entry, r.body, false);
  const changes = out.ok ? out.changes : (out.changes ?? []);
  if (!out.ok && !out.needsReplaceConfirmation) { status(out.error, 'err'); return; }
  reviewing = { entry, body: r.body, changes, replace: !out.ok };
  status(out.ok ? `${entry.name}: 차이를 확인하고 적용하세요.` : out.error, out.ok ? '' : 'warn');
  render();
}

async function applyReviewed(): Promise<void> {
  if (!reviewing) return;
  const { entry, body, replace } = reviewing;
  const out = await adopt(state, serverUrl, entry, body, replace);
  if (!out.ok) { status(out.error, 'err'); return; }
  state = out.state;
  reviewing = null;
  await saveState(state);
  status(`${out.descriptor.name} v${out.descriptor.version}을(를) 적용했어요 (sha256 ${short(entry.sha256)}). ` +
    '사이트 권한이 필요하면 위에서 허용하고, 열려 있는 페이지는 새로고침하세요.', 'ok');
  render();
}

function offerCard(e: IndexEntry): HTMLElement {
  const origin = serverOrigin(serverUrl);
  const pinned = state.adopted.find((a) => a.id === e.id && a.server === origin);
  const update = pinned && pinned.sha256 !== e.sha256;
  const offered = openOffers(state, serverUrl, [e]).length > 0;
  const label = pinned ? (update ? '업데이트 있음' : '사용 중') : offered ? '새 설명' : '거절함';
  const isReviewing = reviewing?.entry.id === e.id;
  return h('div', { class: 'card' },
    h('h3', {},
      h('span', {}, e.name), h('code', {}, e.id), h('span', { class: 'tag' }, `v${e.version}`),
      h('span', { class: 'tag', title: e.sha256 }, `sha256 ${short(e.sha256)}`),
      h('span', { class: `tag ${update || offered ? 'warn' : ''}` }, label)),
    h('div', { class: 'hosts' }, `주소: ${e.hosts.join(', ')}`),
    h('div', { class: 'row' },
      (!pinned || update) && h('button', { onclick: () => { void review(e); } }, update ? '차이 보기' : '살펴보기'),
      !pinned && offered && h('button', {
        onclick: async () => {
          state = decline(state, serverUrl, e);
          await saveState(state);
          render();
        },
      }, '거절')),
    isReviewing && reviewing ? h('div', {},
      diffTable(reviewing.changes),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => { void applyReviewed(); } },
          reviewing.replace ? '내장 설명을 이것으로 교체' : '적용'),
        h('button', { onclick: () => { reviewing = null; render(); } }, '닫기'))) : null);
}

function serverSection(): HTMLElement {
  const input = h('input', { type: 'url', placeholder: 'https://sync.example', value: serverUrl });
  const auto = h('input', { type: 'checkbox' });
  auto.addEventListener('change', async () => {
    state = setAutoAdopt(state, serverUrl, auto.checked);
    await saveState(state);
    status(auto.checked
      ? '이 서버의 업데이트 중 범위를 넓히지 않는 것은 묻지 않고 적용해요.'
      : '이 서버의 업데이트는 모두 물어볼게요.', 'ok');
  });
  const list = h('div', {});
  /** Everything here that depends on which server is typed in. */
  const fill = () => {
    const origin = serverOrigin(serverUrl);
    auto.checked = state.servers[origin]?.autoAdopt === true;
    auto.disabled = !origin;
    list.textContent = '';
    if (index === null) return;
    const updates = pendingUpdates(state, serverUrl, index);
    list.append(index.length === 0
      ? h('p', { class: 'muted' }, '이 서버는 제공하는 설명이 없어요.')
      : h('div', {},
        updates.length ? h('p', {}, `업데이트 ${updates.length}개가 있어요.`) : null,
        ...index.map(offerCard)));
  };
  // Updated in place, never with render(): `change` fires on the blur that
  // pressing 불러오기 or the checkbox causes, between mousedown and mouseup,
  // and a browser clicks only an element both landed on. Rebuilding the
  // section there swallowed that first click.
  input.addEventListener('change', () => {
    serverUrl = input.value.trim();
    index = null;
    reviewing = null;
    fill();
  });
  fill();
  return h('section', {},
    h('h2', {}, '서버가 제공하는 설명'),
    h('p', { class: 'muted' }, '서버의 설명은 여기서 적용하기 전까지 쓰이지 않아요. 적용하면 그 파일의 해시로 고정되고, ' +
      '서버에서 바뀌면 다시 물어봐요. 사이트·주소·경로 범위를 넓히는 변경은 자동 적용에서도 항상 물어봐요.'),
    h('div', { class: 'row' }, input, h('button', { onclick: () => { serverUrl = input.value.trim(); void loadIndex(); } }, '불러오기')),
    h('div', { class: 'row' }, h('label', { class: 'inline' }, auto, '이 서버에서 범위를 넓히지 않는 업데이트는 자동 적용')),
    list);
}

function render(): void {
  app.textContent = '';
  app.append(statusEl, serverSection(), effectiveSection(), draftSection());
}

void (async () => {
  const all = await loadAll();
  state = all.state;
  serverUrl = all.server;
  await refreshOrigins();
  render();
  if (serverOrigin(serverUrl)) void loadIndex();
  // Another surface (the content script's auto-adopt, a second options tab)
  // may change the same keys.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.keys(changes).some((k) => k.startsWith(`${PREFIX}providers.`))) return;
    void loadAll().then((x) => { state = x.state; render(); });
  });
})();
