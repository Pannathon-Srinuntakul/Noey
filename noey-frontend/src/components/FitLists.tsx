/**
 * Two ruled lists side by side — "suits this work" and "cannot do yet".
 * Used by the home scope teaser and /scope.
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
    <div className="fit-lists">
      <div className="fit-lists__col">
        <Heading className="fit-lists__title">{fitTitle}</Heading>
        <ul className="ruled-list">
          {fits.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <div className="fit-lists__col fit-lists__col--muted">
        <Heading className="fit-lists__title">{misfitTitle}</Heading>
        <ul className="ruled-list">
          {misfits.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
