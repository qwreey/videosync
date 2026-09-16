/**
 * The content script's side of provider descriptors: the registry in force on
 * this page, and what the joined server has changed.
 *
 * Everything that decides is in client/core (adoption.ts, manage.ts); this
 * file only knows where the extension keeps things and how it reaches the
 * worker.
 */
import type { ProviderHooks, Store } from '@videosync/core/app/bootstrap.ts';
import { buildRegistry, parseIndex, readState } from '@videosync/core/providers/adoption.ts';
import { autoUpdateStored, grantedBy } from '@videosync/core/providers/manage.ts';

import { ask, authCall } from './relay.ts';
import type { GrantedReply } from './relay.ts';
import { loadProviderState } from './storage.ts';

export async function providerHooks(store: Store): Promise<ProviderHooks> {
  // A content script has no `permissions` API; the worker does.
  const { origins } = await ask<GrantedReply>({ t: 'providers.granted' }, { origins: [] });
  const registry = buildRegistry(readState(store.load), grantedBy(origins));
  return {
    registry,
    decideWhere: 'VideoSync 확장 프로그램의 옵션 페이지',
    async updatesFrom(serverUrl) {
      // Through the worker, on the same path policy as every other call; a
      // server that gates its listing gets the device token there.
      const idx = await authCall(serverUrl, '/api/providers', { method: 'GET' });
      if (idx.status !== 200 || idx.gateway) return [];
      const fetchBody = async (id: string) => {
        const f = await authCall(serverUrl, `/api/providers/${id}.json`, { method: 'GET' });
        if (f.status !== 200 || f.gateway) throw new Error(`HTTP ${f.status}`);
        return f.body;
      };
      // What auto-adopt may take is taken now and applies from the next page
      // load: this page was already set up with the old copy, and swapping a
      // descriptor under a running session would change its key mid-room.
      // Read from storage itself, before and after the fetch, and only the
      // pin written: the options page may have changed things meanwhile.
      const pending = await autoUpdateStored(loadProviderState, store.save, serverUrl, parseIndex(idx.body), fetchBody);
      return pending.map((e) => ({ id: e.id, name: e.name }));
    },
  };
}
