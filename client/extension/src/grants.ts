/**
 * Whether the user has granted every site a descriptor asks for: what the
 * options page shows, and whether it offers the grant button.
 *
 * Kept apart from options.ts (which touches the DOM on load) so it can be
 * tested. The probe per host must agree with what the registration
 * (`dynamicPagePatterns`) and the follow check test later -- the exact page
 * hostname -- or the card says "granted" while no page ever gets the content
 * script, and hides the only button that would fix it.
 */
import type { Descriptor } from '@videosync/core/providers/descriptor.ts';

export function sitesGranted(
  d: Pick<Descriptor, 'hosts' | 'pageHosts'>, granted: (hostname: string) => boolean,
): boolean {
  // Every host `originsFor` requests, page hosts included.
  // A wildcard is probed with the literal `*.<base>`: no exact grant can
  // match it (a hostname has no `*`), and a bare-domain grant does not cover
  // it, so only a grant that covers every subdomain -- which is what
  // `https://*.<base>/*` asked for -- answers yes. Probing the bare domain
  // said yes to a bare grant; probing `x.<base>` would say yes to an exact
  // grant of that one name.
  return [...d.hosts, ...(d.pageHosts ?? [])].every((h) => granted(h));
}
