import { getReferenceIndex } from '../lib/references';
export function GET() {
  return new Response(JSON.stringify(getReferenceIndex()), {
    headers: { 'Content-Type': 'application/json' },
  });
}
