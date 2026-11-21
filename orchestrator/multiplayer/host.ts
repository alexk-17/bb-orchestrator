import { gh } from "../open-prs/host.ts";
import { parseReview, reviewArgs, type ReviewRead } from "./core/findings.ts";

export const mpHandlers = {
  "multiplayer.review": async ({ url }: { url: string }): Promise<ReviewRead> => {
    const a = reviewArgs(url);
    const [pull, review, comments] = await Promise.all([gh(a.pull), gh(a.review), gh(a.comments)]);
    return parseReview(pull, review, comments);
  },
};
