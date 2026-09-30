import { AppScreen } from "./app/AppScreen";
import { UsageCard } from "./app/Usage";
import "./app/parts.css";

/**
 * The editor's quota card (settings page) with sample numbers, drawn at the
 * width the app gives it. The pricing page labels it "ตัวอย่างการแสดงผล";
 * the picture itself is hidden from assistive technology.
 */
export function UsageMockup() {
  return (
    <div className="amusage" aria-hidden="true">
      <AppScreen width={412} height={346}>
        <UsageCard />
      </AppScreen>
    </div>
  );
}
