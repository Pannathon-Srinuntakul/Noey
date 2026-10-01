import { LoadingFrame, RenderLoading } from "@/components/shell/RenderLoading";

/**
 * Any page still on its way with no loading state of its own: the centre
 * piece alone, in the middle of <main> — the header and footer stay. Never
 * on a first visit to a marketing page: those are static and arrive whole.
 */
export default function Loading() {
  return (
    <main id="main" className="ld-page">
      <LoadingFrame>
        <RenderLoading />
      </LoadingFrame>
    </main>
  );
}
