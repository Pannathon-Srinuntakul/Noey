import { LoadingFrame, RenderLoading, Skel, SkelLines } from "./RenderLoading";
import "../../styles/parts/status.css";

/**
 * The utility pages (verify email, reset password, checkout): the status card
 * itself, its emblem the centre piece — the mark drawing itself over the
 * waveform — its title, words and action as bars. The strip reads as the
 * pending card's does ("RENDERING"), with the task the page belongs to.
 */
export function StatusCardSkeleton({ task }: { task: string }) {
  return (
    <section className="status status--pending status--skel">
      <div className="status__strip" aria-hidden="true">
        <span className="status__rec" />
        <span className="tc">RENDERING</span>
        <span className="status__rule" />
        <span className="status__task">{task}</span>
      </div>
      <div className="status__emblem">
        <span className="status__halo" aria-hidden="true" />
        <RenderLoading variant="emblem" />
      </div>
      <div className="status__title" aria-hidden="true">
        <Skel w="9em" />
      </div>
      <div className="status__body" aria-hidden="true">
        <SkelLines widths={["100%", "68%"]} />
      </div>
      <div className="status__actions" aria-hidden="true">
        <Skel className="skel--box" w="11em" h="52px" />
      </div>
    </section>
  );
}

/** The route loading state: the card on its status page. */
export function StatusSkeleton({ task }: { task: string }) {
  return (
    <main id="main" className="status-page page-top status-page--skel">
      <div className="wrap">
        <LoadingFrame>
          <StatusCardSkeleton task={task} />
        </LoadingFrame>
      </div>
    </main>
  );
}
