import { getCatalogue } from '../../lib/catalogue';
import { renderReference } from '../../lib/references';
export function getStaticPaths() {
  return getCatalogue().references.map((entry) => ({
    params: { id: entry.id },
    props: { entry },
  }));
}
export function GET({
  props,
}: {
  props: { entry: ReturnType<typeof getCatalogue>['references'][number] };
}) {
  return new Response(
    JSON.stringify(renderReference(props.entry, getCatalogue().root)),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
