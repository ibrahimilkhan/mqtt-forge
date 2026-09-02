import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setReconnectEnabled } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { useReconnectStatus } from '../../api/useReconnectStatus';
import { logFault } from '../../stores/logStore';
import styles from './AutoReconnectSwitch.module.css';
import { arrived } from './reconnectView';

/**
 * The standing answer: is a link that drops put back up.
 *
 * It stands with the form, and only while there is no link — which is the whole of what makes it
 * a setting rather than a control. Over a live link it would be a switch about a thing that is
 * not happening, sitting on a panel whose job at that moment is to report; and the panel has
 * nothing else on it then, so the switch would be the loudest thing on a screen about a
 * connection that is perfectly fine.
 *
 * Its own component rather than eight lines inside the panel, because the mutation behind it has
 * to write the cache from its own answer — see below — and that is the sort of thing that gets
 * copied and then diverges. It had a second home inside the reconnect block for an afternoon;
 * every state that block draws is a state with no link, which is a panel already showing this
 * switch a few inches down, so two of them were on screen at once.
 */
export function AutoReconnectSwitch({ id }: { id: string }) {
  const { status } = useReconnectStatus();
  const queryClient = useQueryClient();

  const option = useMutation({
    mutationFn: setReconnectEnabled,
    // Written from the answer rather than invalidated and re-fetched: the endpoint sends back the
    // status it produced, the hub sends the same one a beat later, and they agree. A refetch
    // would put a round trip between the click and the switch moving.
    onSuccess: (result) => queryClient.setQueryData(queryKeys.reconnect, arrived(result)),
    onError: (error) => logFault('Could not change auto-reconnect', error),
  });

  return (
    <label className={styles.option} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={status.enabled}
        disabled={option.isPending}
        onChange={(e) => option.mutate(e.target.checked)}
      />
      <span>Reconnect automatically if the link drops</span>
    </label>
  );
}
