import { IconCheck, IconMinus } from "./ds/icons";
import "../styles/parts/story.css";

/**
 * "Suits this work" and "cannot do yet" as two parallel tracks of equal
 * weight: the limits get the same size, contrast and space as the strengths,
 * so nothing about the product is hidden in small print. Used by the home
 * scope teaser and /scope.
 */
export function FitLists({
  fits,
  misfits,
  fitTitle,
  misfitTitle,
  headingLevel,
}: {
  fits: readonly string[];
  misfits: readonly string[];
  fitTitle: string;
  misfitTitle: string;
  headingLevel: "h2" | "h3";
}) {
  const Heading = headingLevel;
  return (
    <div className="lanes" data-reveal="lanes">
      <div className="lane lane--fit">
        <div className="lane__head">
          <span className="trk tc" aria-hidden="true">
            V1
          </span>
          <Heading className="lane__title">{fitTitle}</Heading>
        </div>
        <ul className="lane__clips">
          {fits.map((item, index) => (
            <li key={item} className="lane__clip" style={{ ["--i" as string]: index }}>
              <span className="lane__icon" aria-hidden="true">
                <IconCheck size={15} />
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="lane lane--misfit">
        <div className="lane__head">
          <span className="trk tc" aria-hidden="true">
            V2
          </span>
          <Heading className="lane__title">{misfitTitle}</Heading>
        </div>
        <ul className="lane__clips">
          {misfits.map((item, index) => (
            <li key={item} className="lane__clip" style={{ ["--i" as string]: index }}>
              <span className="lane__icon" aria-hidden="true">
                <IconMinus size={15} />
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
