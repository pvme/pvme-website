// Only for the local Functions Framework test. No external request is performed.
globalThis.fetch = async (url) => {
  if (
    url === 'https://raw.githubusercontent.com/pvme/pvme-guides/master/test.txt'
  )
    return new Response('Original Unicode é\r\nSecond\n');
  throw new Error(
    'External network forbidden by website dry-run integration test',
  );
};
