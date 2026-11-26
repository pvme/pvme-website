import type { APIRoute, GetStaticPaths } from 'astro';
import { getCatalogue } from '../../lib/catalogue';
import { loadGuideSource } from '../../lib/guide-source';

export const getStaticPaths: GetStaticPaths = () =>
  [...new Set(getCatalogue().guides.map((guide) => guide.path))].map(
    (path) => ({
      params: { path },
      props: { path },
    }),
  );

export const GET: APIRoute = ({ props }) => {
  const { root, guides } = getCatalogue();
  return new Response(
    JSON.stringify(loadGuideSource(props.path, root, guides)),
    {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    },
  );
};
