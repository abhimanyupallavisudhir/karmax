import 'dotenv/config';
import { Template, defaultBuildLogger } from 'e2b';

const image = process.env.KARMAX_BROWSER_IMAGE;
if (!image) throw new Error('KARMAX_BROWSER_IMAGE must name the published environments/browser image');

const tag = process.env.KARMAX_E2B_TEMPLATE_TAG ?? 'karmax-browser-v1';
const template = Template().fromImage(image);

await Template.build(template, tag, {
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
});
