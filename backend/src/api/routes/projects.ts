// Thin HTTP adapter for the projects directory. All query + aggregation + DTO
// logic lives in the projection layer (projects/projections.ts); this handler
// only forwards. GET /api/projects → { projects: Project[] }.
import { fetchProjects } from "../../projects/projections.ts";

export async function getProjects() {
  return fetchProjects();
}
