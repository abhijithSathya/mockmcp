import { handleHttpRequest } from "./mock-core.mjs";

export default {
  async fetch(request, env) {
    return handleHttpRequest(request, env);
  }
};
