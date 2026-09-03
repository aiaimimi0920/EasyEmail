import { useAppController } from "./app/useAppController";
import { AppView } from "./components/AppView";
import "./App.css";
import "./styles/neuro-canonical.css";

export default function App() {
  return <AppView controller={useAppController()} />;
}
