/**
 * What a record holds under `key` as its own, or undefined: never what every object answers to.
 *
 * A record kept by a flow's id or a node's is keyed by text the server chose, and its pattern,
 * ^[A-Za-z0-9_-]{1,40}$, takes __proto__, constructor and toString as readily as any other. Read as
 * `record[id]`, every record already holds something under each of them — what an object inherits
 * from, the Object function, a method — and `id in record` says so too. A flow called constructor was
 * the Object function to the page, which fell over drawing it, and the lines of one called toString
 * were dropped as those of a flow deleted. So such a record is read through this.
 *
 * And written as own properties only: by a computed key in an object literal, by spreading one record
 * into another, or by Object.fromEntries. `record['__proto__'] = value` does not write a property at
 * all — it changes what the record inherits from — and `(record[id] ??= {})` finds something already
 * there under each of the three, and writes on that instead: a status push with a test of a flow called
 * __proto__ filed the run on every object in the console.
 */
export const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;
