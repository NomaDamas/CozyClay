import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "reactflow/dist/style.css";
import "./workflow.css";
import "./cozy-scene-node.css";
import WorkflowBuilder from "./WorkflowBuilder.jsx";

createRoot(document.getElementById("workflow-root")).render(
	<StrictMode>
		<WorkflowBuilder />
	</StrictMode>,
);
