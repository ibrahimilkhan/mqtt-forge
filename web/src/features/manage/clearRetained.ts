import { publish } from '../../api/publish';

/**
 * How many are sent at once. Enough that a hundred topics is a moment rather than a minute, few
 * enough that the console does not throw a hundred publishes at a broker somebody else is using.
 */
const AT_A_TIME = 6;

/**
 * Tells the broker to forget the retained message on each of these topics.
 *
 * An empty payload published with the retain flag is how MQTT says it — there is no 'delete
 * retained' in the protocol, and a zero-length retained publish is the sentence that means it in
 * 3.1.1 and in 5.0 alike. So this is an ordinary publish, through the same endpoint everything
 * else publishes through, and a broker that refuses the reader's publishes will refuse these too.
 *
 * Every topic is attempted even when some fail: a reader clearing forty topics wants the
 * thirty-eight the broker allowed, and the count of the two it did not.
 */
export async function clearRetained(
  topics: readonly string[],
): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;

  for (let at = 0; at < topics.length; at += AT_A_TIME) {
    const batch = topics.slice(at, at + AT_A_TIME);

    await Promise.all(
      batch.map(async (topic) => {
        try {
          await publish({ topic, payload: '', payloadEncoding: 'text', qos: 0, retain: true });
          done++;
        } catch {
          // Counted rather than thrown: one topic the broker will not let go of must not stop
          // the other thirty-nine.
          failed++;
        }
      }),
    );
  }

  return { done, failed };
}
