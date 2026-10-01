// Extract the facts the blog MCP tool `get_site_info` serves, straight from
// noey-frontend's own modules, so the backend never retypes product copy.
//
// Run through scripts/build_site_info.py (which writes
// packages/blog/site_info.json); tests/test_blog_site_info.py re-runs it and
// fails when the committed JSON has drifted from the site.
//
// Needs Node >= 22.18 (type stripping on by default). Reads noey-frontend
// read-only; nothing here may write there.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

register(new URL("./ts-resolve.mjs", import.meta.url));

const libDir = process.argv[2];
if (!libDir) {
  console.error("usage: node extract.mjs <noey-frontend/src/lib>");
  process.exit(2);
}
const load = (name) => import(pathToFileURL(path.join(libDir, `${name}.ts`)).href);

// A fixed site origin: the extracted JSON must not depend on the shell's env.
process.env.NEXT_PUBLIC_SITE_URL = "https://noeystudio.com";

const site = await load("site");
const scope = await load("scope");
const guide = await load("guide");
const plans = await load("plans");
const modes = await load("modes");

const page = (key) => {
  const p = site.PAGES[key];
  return { path: p.path, url: site.absoluteUrl(p.path), title: p.title, description: p.description, label: p.label };
};

const out = {
  product: {
    name: site.SITE_NAME,
    site_url: site.SITE_URL,
    description: site.PAGES.home.description,
    about: site.PAGES.about.description,
  },
  modes: modes.MODES.map((m) => ({ id: m.id, name: m.name, fit: m.fit, steps: [...m.steps], result: [...m.result] })),
  scope: {
    system_does: scope.SCOPE_STEPS.map((s) => ({ title: s.title, body: s.body })),
    you_do: scope.SCOPE_YOUR_WORK.flat().map((s) => ({ title: s.title, body: s.body })),
    fits: [...scope.SCOPE_FITS],
    does_not_fit_yet: [...scope.SCOPE_MISFITS],
    summary: scope.SCOPE_SUMMARY.map((s) => ({ label: s.label, text: s.text })),
  },
  plans: plans.TIERS.map((tier) => {
    const c = plans.PLAN_COPY[tier];
    return {
      tier,
      name: c.name,
      blurb: c.pricingBlurb,
      features: [...c.features],
      approx_cuts_per_month: plans.APPROX_CUTS_PER_MONTH[tier],
      footage_per_project: plans.FOOTAGE_PER_PROJECT[tier],
    };
  }),
  plans_note: plans.CLIPS_FOOTNOTE,
  pages: Object.fromEntries(
    ["home", "scope", "pricing", "signup", "about", "guide", "changelog"].map((k) => [k, page(k)]),
  ),
  guides: guide.GUIDE_ORDER.map((key) => {
    const doc = guide.GUIDE_DOCS[key];
    return {
      title: doc.h1,
      path: site.PAGES[key].path,
      url: site.absoluteUrl(site.PAGES[key].path),
      answer: doc.answer,
      sections: doc.sections.map((s) => s.title),
    };
  }),
};

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
