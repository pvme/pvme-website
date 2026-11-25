export type JsonPath = (string | number)[];
interface Token {
  start: number;
  end: number;
  value: unknown;
}

/** Map JSON lexical tokens, never offsets from rendered/decoded Markdown. */
export function jsonSource(source: string) {
  const tokens = new Map<string, Token>();
  let position = source.search(/[\[{]/);
  if (position < 0) throw new Error('No editable JSON object found');
  const whitespace = () => {
    while (/\s/.test(source[position] || '') && position < source.length)
      position++;
  };
  const string = () => {
    const start = position++;
    while (position < source.length) {
      const char = source[position++];
      if (char === '\\') position++;
      else if (char === '"')
        return JSON.parse(source.slice(start, position)) as string;
    }
    throw new Error('Unterminated JSON string');
  };
  const read = (path: JsonPath): unknown => {
    whitespace();
    const start = position;
    let value: unknown;
    if (source[position] === '"') value = string();
    else if (source[position] === '{') {
      position++;
      const object: Record<string, unknown> = Object.create(null);
      whitespace();
      while (source[position] !== '}') {
        if (source[position] !== '"') throw new Error('Invalid JSON property');
        const key = string();
        if (Object.hasOwn(object, key))
          throw new Error('Duplicate JSON properties require advanced editing');
        whitespace();
        if (source[position++] !== ':')
          throw new Error('Invalid JSON property');
        object[key] = read([...path, key]);
        whitespace();
        if (source[position] !== ',') break;
        position++;
        whitespace();
        if (source[position] === '}') throw new Error('Invalid JSON comma');
      }
      if (source[position++] !== '}') throw new Error('Invalid JSON object');
      value = object;
    } else if (source[position] === '[') {
      position++;
      const array: unknown[] = [];
      whitespace();
      while (source[position] !== ']') {
        array.push(read([...path, array.length]));
        whitespace();
        if (source[position] !== ',') break;
        position++;
        whitespace();
        if (source[position] === ']') throw new Error('Invalid JSON comma');
      }
      if (source[position++] !== ']') throw new Error('Invalid JSON array');
      value = array;
    } else {
      const match =
        /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
          source.slice(position),
        );
      if (!match) throw new Error('Invalid JSON value');
      position += match[0].length;
      value = JSON.parse(match[0]);
    }
    tokens.set(JSON.stringify(path), { start, end: position, value });
    return value;
  };
  const value = read([]);
  return { value, tokens };
}

export function patchJsonProperty(
  source: string,
  path: JsonPath,
  value: unknown,
): string {
  const { tokens } = jsonSource(source);
  const token = tokens.get(JSON.stringify(path));
  if (token) {
    if (JSON.stringify(token.value) === JSON.stringify(value)) return source;
    return (
      source.slice(0, token.start) +
      JSON.stringify(value) +
      source.slice(token.end)
    );
  }
  const parent = tokens.get(JSON.stringify(path.slice(0, -1)));
  if (
    !parent ||
    !parent.value ||
    typeof parent.value !== 'object' ||
    Array.isArray(parent.value) ||
    typeof path.at(-1) !== 'string'
  )
    throw new Error(
      'This property cannot be added safely; use advanced source',
    );
  const insertion = `${Object.keys(parent.value).length ? ',' : ''}${JSON.stringify(path.at(-1))}: ${JSON.stringify(value)}`;
  return (
    source.slice(0, parent.end - 1) + insertion + source.slice(parent.end - 1)
  );
}

export function embedTextPath(path: JsonPath): boolean {
  const key = path.at(-1),
    parent = path.at(-2);
  return (
    ['title', 'description', 'content'].includes(String(key)) ||
    (key === 'name' && (parent === 'author' || typeof parent === 'number')) ||
    (key === 'value' && typeof parent === 'number') ||
    (key === 'text' && parent === 'footer')
  );
}

/** Structural field edits retain the original lexical tokens of surviving fields. */
export function patchJsonArray(
  source: string,
  path: JsonPath,
  values: unknown[],
): string {
  const { tokens } = jsonSource(source);
  const token = tokens.get(JSON.stringify(path));
  if (!token) return patchJsonProperty(source, path, values);
  if (!Array.isArray(token.value)) throw new Error('Expected an array');
  if (JSON.stringify(token.value) === JSON.stringify(values)) return source;
  const children = token.value.map((_, index) =>
    tokens.get(JSON.stringify([...path, index]))!,
  );
  const used = new Set<number>();
  const content = values.map((value) => {
    const index = children.findIndex(
      (child, index) =>
        !used.has(index) &&
        JSON.stringify(child.value) === JSON.stringify(value),
    );
    if (index < 0) return JSON.stringify(value);
    used.add(index);
    return source.slice(children[index].start, children[index].end);
  });
  const prefix = children.length
    ? source.slice(token.start + 1, children[0].start)
    : source.slice(token.start + 1, token.end - 1);
  const suffix = children.length
    ? source.slice(children.at(-1)!.end, token.end - 1)
    : '';
  const separator =
    children.length > 1
      ? source.slice(children[0].end, children[1].start)
      : ',' + prefix;
  return (
    source.slice(0, token.start) +
    '[' +
    prefix +
    content.join(separator) +
    suffix +
    ']' +
    source.slice(token.end)
  );
}
