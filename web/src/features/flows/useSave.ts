import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getFlows, isFlowInvalid, putFlow } from '../../api/flows';
import { queryKeys } from '../../api/queryKeys';
import { ApiError, describeError } from '../../lib/problemDetails';
import { logFault } from '../../stores/logStore';
import type { FlowDto, FlowsDto } from '../../types/api';
import { fingerprint, sameFlow, standingOf, titleOf } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';

/**
 * Puts what the server now has of one flow into the list the page reads — `kept`, or nothing once
 * it is deleted — with no problems filed against it, without waiting for the read that follows.
 *
 * A read of the list already on its way — the window came back into focus, say — was answered
 * before this, and let in after it would put the old flow back. So it is called off first.
 */
export async function putInList(queryClient: QueryClient, id: string, kept: FlowDto | null) {
  await queryClient.cancelQueries({ queryKey: queryKeys.flows });
  queryClient.setQueryData<FlowsDto>(queryKeys.flows, (old) => {
    if (!old) return old;

    const others = old.flows.filter((one) => one.id !== id);
    // A kept flow stays where it was in the list, so its tab does not move.
    const flows =
      kept === null
        ? others
        : old.flows.some((one) => one.id === id)
          ? old.flows.map((one) => (one.id === id ? kept : one))
          : [...old.flows, kept];
    return { ...old, flows, problems: old.problems.filter((problem) => problem.flowId !== id) };
  });
}

/**
 * The button pressed, which says what the press expects of the server's copy: Activate, of a flow
 * the server has switched off or does not have; Update and Deactivate, of one it has switched on.
 */
export type SaveKind = 'activate' | 'update' | 'deactivate';

/**
 * Why a save sent nothing: what the list it read first had of the flow that the page did not, when
 * the reader pressed.
 *
 * - `overtaken`: the draft was started from a copy another console has since replaced or deleted
 *   (see standingOf). It stays, held back, until its reader keeps it or lets it go in its pane.
 * - `changed`, `deleted`: a flow with no draft, pressed as the copy this page read, which another
 *   console has since changed or deleted. What the server has now is on screen in its place.
 * - `changedOn`: changed, and switched on as well, where an Activate of a flow with no draft finds
 *   it: the flow is on, though not as it was pressed.
 * - `off`: switched off by another console since this page read it. An Update would start again a
 *   flow somebody stopped; a Deactivate finds done what it asked for.
 * - `on`: switched on by another console since this page read it, which is all an Activate of a
 *   flow with no draft asked for.
 */
export type Held = 'overtaken' | 'changed' | 'changedOn' | 'deleted' | 'off' | 'on';

/**
 * A save that did not save what was pressed: the flow, by its id and by the name it was pressed
 * with — in a live region, a name read from the draft would be said again with every letter of a
 * rename — and either why nothing was sent, or what the server refused of it. With why, the copy a
 * draft was started from, for the page to say a draft held back while that draft is held back; with
 * what was refused, the very object filed, for the page to say it while that refusal stands.
 */
export type Unsaved =
  | { id: string; name: string; held: Held; base: string | null }
  | { id: string; name: string; refused: Record<string, string[]> };

/**
 * What a save says when the list could not be read before it. Nothing was sent: without the
 * server's copy there is no telling whether another console has overtaken the draft since.
 */
const unread = (error: unknown) =>
  new ApiError(
    error instanceof ApiError ? error.status : 0,
    `The flows could not be read from the server first, so nothing was sent. ${describeError(error)}`,
  );

/**
 * What a press comes to against the list read just before it, `copy` being the server's copy there:
 * the flow to send, or why nothing goes.
 *
 * What Activate and Update press is a drawing: the flow's draft, or for a flow with none, the copy
 * this page read, as the page showed it. A drawing goes only onto the copy it was drawn on. A draft
 * of a copy the server has replaced or deleted since is held back until its reader keeps it or lets
 * it go (see standingOf). A flow with no draft has no copy kept of where it started, and needs none:
 * the copy it was pressed as is the one to find in the list, as it was, or nothing goes.
 *
 * Whether a flow is switched on is no part of a drawing (see canonical), so each press says what it
 * expects of it. Update expects a flow that is on: one another console has switched off since is
 * not started again over whoever stopped it. Activate of a flow with no draft expects one that is
 * off: one switched on since has nothing left to send, and is said to be on whether or not it was
 * changed as well. A draft is the reader's changes, and Activate saves them however the flow is
 * switched now.
 *
 * Deactivate sends the server's copy, not the drawing: the run stops however the drawing stands. The
 * copy is the one in the list just read, so a flow another console has saved since goes back
 * switched off as that console left it, not as this page last saw it; and one the server no longer
 * has, or has switched off already, is left as it is.
 */
function weigh(
  kind: SaveKind,
  flow: FlowDto,
  drafted: boolean,
  base: string | null,
  copy: FlowDto | undefined,
): FlowDto | Held {
  if (kind === 'deactivate') return copy === undefined ? 'deleted' : copy.enabled ? copy : 'off';

  if (drafted) {
    if (standingOf(flow, base, copy) === 'overtaken') return 'overtaken';
  } else {
    if (copy === undefined) return 'deleted';
    if (!sameFlow(flow, copy)) return kind === 'activate' && copy.enabled ? 'changedOn' : 'changed';
    if (kind === 'activate' && copy.enabled) return 'on';
  }

  // A draft with no copy to find that was not held back above is of a flow started here, which the
  // server never had and no page offers Update for. Should one come, it is not there to update.
  if (kind === 'update' && !copy?.enabled) return copy === undefined ? 'deleted' : 'off';
  return flow;
}

/**
 * Saves the flow on screen, switched on or off, on its own request, and answers with what came of it
 * when it was not saved: held back, or refused.
 *
 * It reads the list first, as Deploy did: a drawing of a copy another console has since replaced
 * or deleted is held back rather than sent over it (see weigh), and only a list read now can tell.
 * The list it reads goes on screen, so what was held back is seen beside what the server has now. A
 * list that cannot be read sends nothing, and says so. What the server keeps goes into the list
 * before the draft it was sent from goes, and what was typed while the request was out stays a draft
 * of the copy just kept.
 *
 * What the server refuses of the copy a Deactivate sends is not about the drawing, so it is not
 * marked there: it fails the save, which says why.
 */
export function useSave() {
  const queryClient = useQueryClient();

  return useMutation({
    // Only Deactivate sends `enabled: false`, and it sends the server's copy rather than the
    // drawing: Activate and Update send the flow as drawn, switched on.
    mutationFn: async ({ flow, kind }: { flow: FlowDto; kind: SaveKind }): Promise<Unsaved | null> => {
      const drawing = kind !== 'deactivate';
      // What was pressed, as it was pressed: a draft, and the copy it was started from, or the
      // server's own copy of a flow with none.
      const { drafts, bases } = useFlowDraftStore.getState();
      const drafted = flow.id in drafts;
      const base = bases[flow.id] ?? null;

      // Asked here rather than through the query's fetchQuery, whose read the page can cancel while
      // it is out — a delete's answer cancels the list's reads — and a cancelled fetchQuery hands
      // back the list the cache already had, without a word.
      let read: FlowsDto;
      try {
        read = await getFlows();
      } catch (error) {
        throw unread(error);
      }

      // A read of the list still out set off before this one did: let in after it, it would put the
      // older list back. The list is put where the page reads it, so the page marks a draft this
      // holds back as held back.
      await queryClient.cancelQueries({ queryKey: queryKeys.flows });
      queryClient.setQueryData<FlowsDto>(queryKeys.flows, read);
      // As the cache keeps it: a copy that has not changed is still the object the page worked out
      // its answers about.
      const now = queryClient.getQueryData<FlowsDto>(queryKeys.flows) ?? read;
      if (now.unreadable) return null;

      const sent = weigh(kind, flow, drafted, base, now.flows.find((one) => one.id === flow.id));
      if (typeof sent === 'string') return { id: flow.id, name: titleOf(flow), held: sent, base };

      try {
        const { flow: kept } = await putFlow({ ...sent, enabled: drawing });
        // Before the draft goes, so the tab never shows the old flow in between.
        await putInList(queryClient, kept.id, kept);

        if (drawing) {
          // What was typed while the request was out is an edit of the copy just kept. What the
          // server refused of an earlier drawing goes with the draft it was about.
          const store = useFlowDraftStore.getState();
          const since = store.drafts[flow.id];
          store.settle([flow.id]);
          if (since !== undefined && !sameFlow(since, flow)) store.put(since, fingerprint(kept));
        }
        return null;
      } catch (error) {
        if (!drawing || !isFlowInvalid(error)) throw error;

        // Marked on the drawing it is about, while there is one (see refuse).
        const refused = error.errors ?? { flow: [error.message] };
        useFlowDraftStore.getState().refuse(flow, drafted, refused);
        return { id: flow.id, name: titleOf(flow), refused };
      }
    },
    onError: (error, { kind }) => logFault(kind === 'deactivate' ? 'Flow not switched off' : 'Flow not saved', error),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.flows }),
  });
}
