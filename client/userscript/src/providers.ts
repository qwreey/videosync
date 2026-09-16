/**
 * Provider descriptors in the userscript: the registry, update notices, and
 * the Tampermonkey menu commands that stand in for the extension's options
 * page.
 *
 * A userscript has no page of its own, so decisions are made in `prompt` and
 * `confirm` dialogs opened from the manager's menu -- still outside the page's
 * reach, which is what matters. It also cannot add sites to itself: a site
 * from a descriptor only works once the user adds its `@match` line, and the
 * menu says which. Every rule is in client/core.
 */
import type { ProviderHooks, Store } from '@videosync/core/app/bootstrap.ts';
import {
  buildRegistry, openOffers, parseIndex, pendingUpdates, readState, serverOrigin, writeState,
} from '@videosync/core/providers/adoption.ts';
import type { FieldChange, IndexEntry, ProviderState } from '@videosync/core/providers/adoption.ts';
import {
  adopt, autoUpdate, grantedBy, missingMatches, removeUser, saveUser, setAutoAdopt, unadopt,
} from '@videosync/core/providers/manage.ts';

declare const GM_registerMenuCommand: undefined | ((name: string, fn: () => void) => unknown);
declare const GM_info: undefined | { script?: { matches?: string[]; includes?: string[] } };

/** The script's own `@match` lines, which are the sites it can run on and so may follow into. */
function ownMatches(): string[] {
  try {
    const s = typeof GM_info === 'object' ? GM_info?.script : undefined;
    return [...(s?.matches ?? []), ...(s?.includes ?? [])];
  } catch {
    return [];
  }
}

async function getText(url: string): Promise<string> {
  // A userscript's server is public with CORS anyway (see reach.ts).
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function fetchIndex(server: string): Promise<IndexEntry[]> {
  return parseIndex(await getText(new URL('/api/providers', server).toString()));
}

const fileUrl = (server: string, id: string) => new URL(`/api/providers/${id}.json`, server).toString();

function describeChanges(changes: readonly FieldChange[]): string {
  if (!changes.length) return '(달라지는 내용 없음)';
  return changes.map((c) => `${c.widens ? '⚠ 넓어짐 ' : ''}${c.field}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`)
    .join('\n').slice(0, 1500);
}

export function providerHooks(store: Store): ProviderHooks {
  return {
    registry: buildRegistry(readState(store.load), grantedBy(ownMatches())),
    decideWhere: 'Tampermonkey 메뉴의 "VideoSync: 서버 제공자 설명"',
    async updatesFrom(serverUrl) {
      const index = await fetchIndex(serverUrl);
      const r = await autoUpdate(readState(store.load), serverUrl, index, (id) => getText(fileUrl(serverUrl, id)));
      if (r.applied.length) writeState(store.save, r.state);
      return r.pending.map((e) => ({ id: e.id, name: e.name }));
    },
  };
}

function afterChange(what: string, missing: string[]): void {
  const lines = [`${what}`, '', '페이지를 새로고침하면 반영돼요.'];
  if (missing.length) {
    lines.push('', '이 스크립트가 그 사이트에서 실행되려면 스크립트 머리말에 다음 줄을 추가하세요:', ...missing);
  }
  alert(lines.join('\n'));
}

async function addFromPaste(store: Store): Promise<void> {
  const text = prompt('제공자 설명 JSON을 붙여 넣으세요 (한 줄이어도 괜찮아요):');
  if (!text) return;
  const state = readState(store.load);
  const r = await saveUser(state, text);
  if (!r.ok) { alert(`쓸 수 없는 설명이에요:\n${r.error}`); return; }
  if (r.changes.length && !confirm(`${r.descriptor.name}(${r.descriptor.id}) 설명을 저장할까요?\n\n${describeChanges(r.changes)}`)) return;
  writeState(store.save, r.state);
  afterChange(`${r.descriptor.name} 설명을 저장했어요.`, missingMatches(r.descriptor, ownMatches()));
}

async function fromServer(store: Store): Promise<void> {
  const server = store.load('server', '');
  if (!serverOrigin(server)) { alert('먼저 패널에서 서버 주소로 방에 참가하세요.'); return; }
  let index: IndexEntry[];
  try {
    index = await fetchIndex(server);
  } catch (e) {
    alert(`서버 목록을 받지 못했어요: ${(e as Error).message}`);
    return;
  }
  let state = readState(store.load);
  const offers = openOffers(state, server, index);
  const updates = pendingUpdates(state, server, index);
  const listed = [...updates, ...offers.filter((o) => !updates.includes(o))];
  const auto = state.servers[serverOrigin(server)]?.autoAdopt === true;
  const menu = [
    `${serverOrigin(server)} 의 제공자 설명`,
    ...listed.map((e, i) => `${i + 1}. ${e.name} (${e.id}) v${e.version}${updates.includes(e) ? ' — 업데이트' : ''}`),
    listed.length ? '' : '새로 받을 것이 없어요.',
    `a. 이 서버의 넓히지 않는 업데이트 자동 적용: ${auto ? '켜짐 → 끄기' : '꺼짐 → 켜기'}`,
    'x. 사용 중인 서버 설명 해제 (id 입력)',
  ].join('\n');
  const pick = prompt(`${menu}\n\n번호, a, 또는 x를 입력하세요:`)?.trim();
  if (!pick) return;
  if (pick === 'a') {
    writeState(store.save, setAutoAdopt(state, server, !auto));
    alert(`자동 적용을 ${auto ? '껐어요' : '켰어요'}.`);
    return;
  }
  if (pick === 'x') {
    const id = prompt('해제할 설명의 id:')?.trim();
    if (!id) return;
    writeState(store.save, unadopt(state, id));
    afterChange(`${id}: 서버 설명을 더 이상 쓰지 않아요.`, []);
    return;
  }
  const e = listed[Number(pick) - 1];
  if (!e) return;
  let body: string;
  try {
    body = await getText(fileUrl(server, e.id));
  } catch (err) {
    alert(`파일을 받지 못했어요: ${(err as Error).message}`);
    return;
  }
  let r = await adopt(state, server, e, body, false);
  if (!r.ok && r.needsReplaceConfirmation) {
    if (!confirm(`${r.error}\n\n${describeChanges(r.changes ?? [])}\n\n내장 설명을 교체할까요?`)) return;
    r = await adopt(state, server, e, body, true);
  } else if (r.ok && !confirm(`${r.descriptor.name} v${r.descriptor.version} 을(를) 적용할까요?\n\n${describeChanges(r.changes)}`)) {
    return;
  }
  if (!r.ok) { alert(r.error); return; }
  state = r.state;
  writeState(store.save, state);
  afterChange(`${r.descriptor.name} 설명을 적용했어요 (sha256 ${e.sha256.slice(0, 12)}).`,
    missingMatches(r.descriptor, ownMatches()));
}

function listAndDelete(store: Store): void {
  const state: ProviderState = readState(store.load);
  const reg = buildRegistry(state, grantedBy(ownMatches()));
  const rows = reg.entries.map((e) =>
    `${e.provider.d.name} (${e.provider.id}) v${e.provider.d.version} · ${e.tier} · ${e.sha256.slice(0, 12)}`);
  const id = prompt(`사용 중인 제공자 설명:\n${rows.join('\n')}${reg.notes.length ? `\n\n${reg.notes.join('\n')}` : ''}` +
    '\n\n내가 추가한 설명을 지우려면 id를 입력하세요:')?.trim();
  if (!id) return;
  writeState(store.save, removeUser(state, id));
  afterChange(`${id} 설명을 지웠어요.`, []);
}

export function registerMenu(store: Store): void {
  if (typeof GM_registerMenuCommand !== 'function') return;
  GM_registerMenuCommand('VideoSync: 제공자 설명 추가', () => { void addFromPaste(store); });
  GM_registerMenuCommand('VideoSync: 서버 제공자 설명', () => { void fromServer(store); });
  GM_registerMenuCommand('VideoSync: 사용 중인 제공자 설명', () => { listAndDelete(store); });
}
