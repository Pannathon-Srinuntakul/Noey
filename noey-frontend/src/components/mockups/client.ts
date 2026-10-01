"use client";

/**
 * The pictures of the app, as client components.
 *
 * Each one draws a whole window of the editor — hundreds of elements, several
 * thousand on the home page. Rendered as server components, that markup went
 * out twice: once as HTML and once more inside the page's RSC payload, which
 * doubled the home page's document (120 KB gzipped). Behind this boundary the
 * payload carries only each picture's props, and the code that draws them —
 * far smaller than what it draws — ships once, in a cached chunk. The HTML is
 * the same: client components are rendered on the server too, so the
 * pictures are there without JavaScript.
 *
 * Import the pictures from here, not from their own modules.
 */
export { EditorMockup } from "./EditorMockup";
export { StepMockup } from "./StepMockup";
export { MicroDemo } from "./MicroDemos";
export { FeatureVisual } from "../home/FeatureVisual";
