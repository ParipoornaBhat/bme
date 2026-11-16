import type { ReactNode } from "react";
import { TrainingDataProvider } from "./TrainingDataProvider";

export default function AdvancedTrainingLayout({ children }: { children: ReactNode }) {
  return <TrainingDataProvider>{children}</TrainingDataProvider>;
}
