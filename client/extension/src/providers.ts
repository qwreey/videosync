/**
 * The content script's side of provider descriptors: the registry in force on
 * this page, and what the joined server has changed.
 *
 * Everything that decides is in client/core (adoption.ts, manage.ts); this
 * file only knows where the extension keeps things and how it reaches the
 * worker.
 */
import type { ProviderHooks, Store } from '@videosync/core/app/bootstrap.ts';
import { buildRegistry, parseIndex, readState, writeState } from '@videosync/core/providers/adoption.ts';
import { autoUpdate, grantedBy } from '@videosync/core/providers/manage.ts';

import { ask } from './relay.ts';
import type { FetchReply, GrantedReply } from './relay.ts';

const FAILED: FetchReply = { ok: false, status: 0, body: '' };

export async function providerHooks(store: Store): Promise<ProviderHooks> {
  // A content script has no `permissions` API; the worker does.
  const { origins } = await ask<GrantedReply>({ t: 'providers.granted' }, { origins: [] });
  const registry = buildRegistry(readState(store.load), grantedBy(origins));
  return {
    registry,
    decideWhere: 'VideoSync 확장 프로그램의 옵션 페이지',
    async updatesFrom(serverUrl) {
      const idx = await ask<FetchReply>({ t: 'providers.fetch', server: serverUrl, path: '/api/providers' }, FAILED);
      if (!idx.ok) return [];
      const fetchBody = async (id: string) => {
        const f = await ask<FetchReply>({ t: 'providers.fetch', server: serverUrl, path: `/api/providers/${id}.json` }, FAILED);
        if (!f.ok) throw new Error(`HTTP ${f.status}`);
        return f.body;
      };
      // What auto-adopt may take is taken now and applies from the next page
      // load: this page was already set up with the old copy, and swapping a
      // descriptor under a running session would change its key mid-room.
      const r = await autoUpdate(readState(store.load), serverUrl, parseIndex(idx.body), fetchBody);
      if (r.applied.length) writeState(store.save, r.state);
      return r.pending.map((e) => ({ id: e.id, name: e.name }));
    },
  };
}
