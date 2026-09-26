// _______________This Code was generated using GenAI tool : Codify, Please check for accuracy_______________
import * as path from 'node:path';
import { execSync as exec } from 'node:child_process';
import * as fs from 'fs-extra';
import * as xml2js from 'xml2js';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages, PackageDir, SfProject } from '@salesforce/core';
import { Duration, sleep } from '@salesforce/kit';
import { Connection } from 'jsforce';
import colors from '@colors/colors';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('dxb', 'community.publish');

// Terminal Status values on BackgroundOperation that stop the poll loop.
const TERMINAL_STATUSES = ['Completed', 'Complete', 'Error'];
// Max number of literals per SOQL/Tooling SOQL "IN" clause batch, to stay well under statement length limits.
const SOQL_BATCH_SIZE = 200;
// Safety cap on how many hops the dependency graph is walked upward before giving up on a branch.
const MAX_TRAVERSAL_DEPTH = 10;

type BackgroundOperationRecord = {
  Id: string;
  Status: string;
};

type PollResult = {
  status: string | undefined;
  timedOut: boolean;
};

type MetadataComponentDependencyRow = {
  MetadataComponentName: string;
  MetadataComponentType: string;
  RefMetadataComponentName: string;
};

type SiteRecord = {
  Name: string;
  MasterLabel: string;
};

type DependencyRoots = {
  directSiteNames: Set<string>;
  lwrRootLwcNames: Set<string>;
};

// Config for manifest metadata types that can represent an Experience Cloud site directly
// (i.e. without needing the LightningComponentBundle dependency-graph traversal). Each entry
// describes where to find the display-name field for a given member, and which bucket that name
// feeds into:
//  - 'site': the parsed value is a Site.Name and still needs the Site query to get MasterLabel
//    (same treatment as the LWC-BFS-resolved names).
//  - 'direct': the parsed value (or, for Network, the member name itself) IS already the
//    community display name and skips the Site query entirely.
// Omitting relativePath/field (Network) means the member name is used as-is.
type DirectMetadataTypeConfig = {
  bucket: 'site' | 'direct';
  relativePath?: (member: string) => string;
  field?: string;
};

const DIRECT_METADATA_TYPES: Record<string, DirectMetadataTypeConfig> = {
  Network: { bucket: 'direct' },
  // experiences/<siteName>.site-meta.xml sits as a sibling file to the experiences/<siteName>/
  // folder (not inside it). Root element <ExperienceBundle>, field <label>.
  ExperienceBundle: { bucket: 'site', relativePath: (m) => `experiences/${m}.site-meta.xml`, field: 'label' },
  // Member format is "site/<bundleName>"; the workspace-root descriptor sits inside the bundle
  // folder itself, named after the bundle: digitalExperiences/site/<bundleName>/<bundleName>.digitalExperience-meta.xml.
  DigitalExperienceBundle: {
    bucket: 'site',
    relativePath: (m) => {
      const bundleName = m.replace(/^site\//, '');
      return `digitalExperiences/site/${bundleName}/${bundleName}.digitalExperience-meta.xml`;
    },
    field: 'label',
  },
  DigitalExperienceConfig: {
    bucket: 'direct',
    relativePath: (m) => `digitalExperienceConfigs/${m}.digitalExperienceConfig-meta.xml`,
    field: 'label',
  },
  CustomSite: { bucket: 'direct', relativePath: (m) => `sites/${m}.site-meta.xml`, field: 'masterLabel' },
  SiteDotCom: { bucket: 'direct', relativePath: (m) => `siteDotComSites/${m}.site-meta.xml`, field: 'label' },
};

export type CommunityPublishJobResult = {
  name: string;
  jobId?: string;
  status?: string;
  timedOut: boolean;
  elapsedMs: number;
};

export type CommunityPublishResult = {
  success: boolean;
  jobs: CommunityPublishJobResult[];
};

export default class CommunityPublish extends SfCommand<CommunityPublishResult> {
  public static readonly summary = messages.getMessage('summary');

  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    name: Flags.string({ char: 'n', summary: messages.getMessage('flags.name.summary'), multiple: true }),
    poll: Flags.boolean({
      char: 'w',
      summary: messages.getMessage('flags.poll.summary'),
      default: false,
    }),
    'poll-interval': Flags.duration({
      unit: 'seconds',
      char: 'i',
      summary: messages.getMessage('flags.poll-interval.summary'),
      defaultValue: 5,
      min: 1,
    }),
    'poll-timeout': Flags.duration({
      unit: 'seconds',
      char: 'o',
      summary: messages.getMessage('flags.poll-timeout.summary'),
      defaultValue: 600,
      min: 1,
    }),
    manifest: Flags.file({
      char: 'x',
      summary: messages.getMessage('flags.manifest.summary'),
      exists: true,
      exclusive: ['name'],
    }),
  };

  // Set this to true if your command requires a project workspace; 'requiresProject' is false by default
  public static readonly requiresProject = true;

  public async run(): Promise<CommunityPublishResult> {
    const { flags } = await this.parse(CommunityPublish);
    const name = flags.name;
    const username = flags['target-org']?.getUsername();
    const poll = flags.poll;
    const pollInterval = flags['poll-interval'] as Duration;
    const pollTimeout = flags['poll-timeout'] as Duration;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const connection = flags['target-org']!.getConnection();

    const overallStart = Date.now();
    this.styledHeader(messages.getMessage('header.title'));
    this.logHuman(messages.getMessage('info.publishing', [username ?? 'target org']));
    this.logHuman('');

    const communityNames =
      name ??
      (flags.manifest ? await this.getCommunityNamesFromManifest(flags.manifest, connection) : undefined) ??
      this.getLiveCommunityNames(username);
    const jobs: CommunityPublishJobResult[] = [];
    let hasFailure = false;

    for (const elem of communityNames) {
      // Publish jobs run sequentially and (when polling) wait for one job to reach a terminal
      // Status before the next one is submitted, to avoid publish locking errors on the org.
      // eslint-disable-next-line no-await-in-loop
      const job = await this.publishOne(elem, username, poll, connection, pollInterval, pollTimeout);
      jobs.push(job);
      if (job.timedOut || job.status === 'Error') {
        hasFailure = true;
      }
    }

    this.renderPublishResultsTable(jobs);

    const overallStatusLabel = hasFailure ? 'Failed' : 'Succeeded';
    const overallStatusColor = hasFailure ? colors.red : colors.green;
    this.logHuman('');
    this.logHuman(`${messages.getMessage('label.status')} ${colors.bold(overallStatusColor(overallStatusLabel))}`);
    this.logHuman(`${messages.getMessage('label.elapsed')} ${this.formatElapsed(Date.now() - overallStart)}`);

    return { success: !hasFailure, jobs };
  }

  /**
   * Queries all "Live" Network (community) names on the target org. Used when --name is not
   * supplied, so that every live community gets published.
   */
  private getLiveCommunityNames(username: string | undefined): string[] {
    const allcommunities = JSON.parse(
      exec(
        `sf data query --query "SELECT Name FROM Network WHERE Status = 'Live'" --result-format json --target-org ${username}`
      ).toString()
    );
    const records: Array<{ Name: string }> = allcommunities?.result?.records ?? [];
    return records.map((r) => r.Name);
  }

  /**
   * Submits the publish job for a single community and, when polling is enabled, waits for the
   * resulting BackgroundOperation record to reach a terminal Status before returning. Renders a
   * sequential stage checklist (spinner per stage) plus a Status/Elapsed Time summary, similar to
   * the "sf project retrieve start" output.
   */
  private async publishOne(
    communityName: string,
    username: string | undefined,
    poll: boolean,
    connection: Connection,
    pollInterval: Duration,
    pollTimeout: Duration
  ): Promise<CommunityPublishJobResult> {
    const overallStart = Date.now();
    this.logHuman(colors.bold(communityName));

    let stageStart = Date.now();
    this.spinner.start(messages.getMessage('spinner.start.preparing'));
    const command = `sf community publish --name "${communityName}" --target-org ${username} --json`;
    this.spinner.stop(`${messages.getMessage('spinner.stop.preparing')} ${this.formatElapsed(Date.now() - stageStart)}`);

    stageStart = Date.now();
    this.spinner.start(messages.getMessage('spinner.start.sending'));
    const raw = exec(command).toString();
    const parsed = JSON.parse(raw);
    const result = parsed?.result ?? {};
    const jobId: string | undefined = result.jobId;
    this.spinner.stop(`${messages.getMessage('spinner.stop.sending')} ${this.formatElapsed(Date.now() - stageStart)}`);
    this.logHuman(colors.dim(messages.getMessage('log.publishSubmitted', [communityName, jobId ?? 'unknown'])));

    const job: CommunityPublishJobResult = {
      name: communityName,
      jobId,
      status: result.status,
      timedOut: false,
      elapsedMs: 0,
    };

    if (poll && jobId) {
      stageStart = Date.now();
      this.spinner.start(messages.getMessage('spinner.start.waiting'));
      const pollResult = await this.pollBackgroundOperation(connection, jobId, pollInterval, pollTimeout);
      job.status = pollResult.status;
      job.timedOut = pollResult.timedOut;

      const waitLabel = pollResult.timedOut
        ? messages.getMessage('spinner.stop.waiting.timeout')
        : pollResult.status === 'Error'
        ? messages.getMessage('spinner.stop.waiting.error')
        : messages.getMessage('spinner.stop.waiting.complete');
      this.spinner.stop(`${waitLabel} ${this.formatElapsed(Date.now() - stageStart)}`);

      if (pollResult.timedOut) {
        this.warn(messages.getMessage('warning.pollTimeout', [communityName, jobId]));
      } else if (pollResult.status === 'Error') {
        this.warn(messages.getMessage('warning.pollError', [communityName, jobId]));
      }
    }

    job.elapsedMs = Date.now() - overallStart;
    const statusLabel = job.timedOut ? 'Timed Out' : job.status === 'Error' ? 'Failed' : 'Succeeded';
    const statusColor = job.timedOut ? colors.yellow : job.status === 'Error' ? colors.red : colors.green;
    this.logHuman('');
    this.logHuman(`${messages.getMessage('label.status')} ${colors.bold(statusColor(statusLabel))}`);
    this.logHuman(`${messages.getMessage('label.elapsed')} ${this.formatElapsed(job.elapsedMs)}`);
    this.logHuman('');

    return job;
  }

  /**
   * Polls the BackgroundOperation record for the given jobId at the given interval until its
   * Status reaches a terminal value (Completed/Complete or Error), or until the overall timeout
   * elapses, whichever happens first. The current status is streamed onto the active spinner
   * instead of printing a new log line per poll, to keep the output uncluttered.
   */
  private async pollBackgroundOperation(
    connection: Connection,
    jobId: string,
    interval: Duration,
    timeout: Duration
  ): Promise<PollResult> {
    const deadline = Date.now() + timeout.milliseconds;
    let status: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await connection.query<BackgroundOperationRecord>(
        `SELECT Id, Status FROM BackgroundOperation WHERE Id = '${jobId}'`
      );
      status = result.records?.[0]?.Status;
      this.spinner.status = messages.getMessage('spinner.status.polling', [status ?? 'Unknown']);

      if (status && TERMINAL_STATUSES.includes(status)) {
        return { status, timedOut: false };
      }
      if (Date.now() >= deadline) {
        return { status, timedOut: true };
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(interval);
    }
  }

  /**
   * Resolves community (Network) names to publish from a delta manifest (package.xml produced by
   * `dxb source delta`). Two families of manifest members are relevant:
   *  - LightningComponentBundle members are walked upward through the MetadataComponentDependency
   *    graph until they reach a component actually placed on an Experience Cloud page
   *    (ExperienceBundle for Aura, DigitalExperience for LWR), since a changed LWC is often a
   *    nested/utility component and not the one dragged onto the page itself.
   *  - Members of ExperienceBundle, DigitalExperienceBundle, DigitalExperienceConfig, Network,
   *    CustomSite, and SiteDotCom represent a site/community directly and are resolved via
   *    DIRECT_METADATA_TYPES (see resolveDirectMetadataNames) without needing the dependency graph.
   *
   * NOTE: MetadataComponentDependency is populated by the org after a successful deploy and its
   * refresh is not always instantaneous, so this flag is meant to be used post-deploy.
   */
  private async getCommunityNamesFromManifest(manifestPath: string, connection: Connection): Promise<string[]> {
    const membersByType = await this.extractMembersFromManifest(manifestPath);
    const lwcMembers = membersByType.get('LightningComponentBundle') ?? [];

    const siteNameCandidates = new Set<string>();
    const directCommunityNames = new Set<string>();

    if (lwcMembers.length > 0) {
      this.logHuman(messages.getMessage('info.resolvingManifestDependencies', [lwcMembers.length]));
      // RefMetadataComponentName is documented as filterable on MetadataComponentDependency, but
      // in practice the Tooling API rejects/ignores WHERE filters on it (it's an unindexed
      // system-computed table) -- only Type/Id fields filter reliably. So the whole graph of
      // "referencers of any LightningComponentBundle" is fetched once (matching
      // ai/metadata_deps.soql) and the upward BFS below walks it in memory instead of issuing a
      // Tooling query per hop.
      const allRows = await this.queryAllLwcReferencerRows(connection);
      const adjacency = this.buildReferencerAdjacency(allRows);
      const { directSiteNames, lwrRootLwcNames } = this.resolveDependencyRoots(adjacency, lwcMembers);
      const lwrSiteNames = await this.resolveLwrSiteNames(lwrRootLwcNames);
      for (const n of directSiteNames) siteNameCandidates.add(n);
      for (const n of lwrSiteNames) siteNameCandidates.add(n);
    }

    const direct = await this.resolveDirectMetadataNames(membersByType);
    for (const n of direct.siteNameCandidates) siteNameCandidates.add(n);
    for (const n of direct.directCommunityNames) directCommunityNames.add(n);

    if (siteNameCandidates.size === 0 && directCommunityNames.size === 0) {
      this.logHuman(messages.getMessage('info.noRelevantMembersInManifest'));
      return [];
    }

    const resolvedFromSite =
      siteNameCandidates.size > 0 ? await this.querySiteMasterLabels(connection, siteNameCandidates) : [];
    const communityNames = [...new Set([...directCommunityNames, ...resolvedFromSite])];

    if (communityNames.length === 0) {
      this.logHuman(messages.getMessage('warning.noSitesResolved'));
      return [];
    }

    this.logHuman(messages.getMessage('info.resolvedSites', [communityNames.join(', ')]));
    return communityNames;
  }

  /**
   * Parses a package.xml and returns every <types> entry as a Map of metadata type name to its
   * <members> list.
   */
  // eslint-disable-next-line class-methods-use-this
  private async extractMembersFromManifest(manifestPath: string): Promise<Map<string, string[]>> {
    const membersByType = new Map<string, string[]>();
    const data = await fs.readFile(manifestPath, { encoding: 'utf8' });
    const result = (await xml2js.parseStringPromise(data, { explicitArray: false }))?.Package;
    if (!result?.types) {
      return membersByType;
    }
    const types: Array<{ name: string; members?: string | string[] }> = Array.isArray(result.types)
      ? result.types
      : [result.types];
    for (const t of types) {
      if (!t.members) {
        continue;
      }
      membersByType.set(t.name, Array.isArray(t.members) ? t.members : [t.members]);
    }
    return membersByType;
  }

  /**
   * Resolves manifest members of the metadata types listed in DIRECT_METADATA_TYPES -- types that
   * represent a site/community directly, without needing the LightningComponentBundle dependency
   * graph. For each member, either the member name itself (Network) or a field parsed out of its
   * source-format meta.xml file (see DIRECT_METADATA_TYPES) becomes a community name candidate,
   * routed into either siteNameCandidates (still needs the Site query to get MasterLabel) or
   * directCommunityNames (already the final display name).
   */
  private async resolveDirectMetadataNames(
    membersByType: Map<string, string[]>
  ): Promise<{ siteNameCandidates: Set<string>; directCommunityNames: Set<string> }> {
    const siteNameCandidates = new Set<string>();
    const directCommunityNames = new Set<string>();

    for (const [typeName, config] of Object.entries(DIRECT_METADATA_TYPES)) {
      const typeMembers = membersByType.get(typeName);
      if (!typeMembers || typeMembers.length === 0) {
        continue;
      }

      for (const member of typeMembers) {
        if (!config.relativePath || !config.field) {
          // Network: the member name itself is the community's fullName, nothing to parse.
          directCommunityNames.add(member);
          continue;
        }

        const relativePath = config.relativePath(member);
        // eslint-disable-next-line no-await-in-loop
        const label = await this.parseMetaXmlField(relativePath, config.field);
        if (label) {
          (config.bucket === 'site' ? siteNameCandidates : directCommunityNames).add(label);
        } else if (typeName === 'DigitalExperienceBundle') {
          // Fall back to the bundle name embedded in the member string itself when the
          // workspace-root descriptor can't be found/parsed locally.
          siteNameCandidates.add(member.replace(/^site\//, ''));
          this.warn(messages.getMessage('warning.metadataFileNotFound', [typeName, relativePath]));
        } else {
          this.warn(messages.getMessage('warning.metadataFileNotFound', [typeName, relativePath]));
        }
      }
    }

    return { siteNameCandidates, directCommunityNames };
  }

  /**
   * Reads a single field's value off the root element of a source-format meta.xml file located at
   * <packageDir>/<relativePath>, trying every package directory in turn. Returns undefined when
   * the file doesn't exist in any package directory, or can't be parsed.
   */
  private async parseMetaXmlField(relativePath: string, fieldName: string): Promise<string | undefined> {
    const filePath = await this.findPackageFile(relativePath);
    if (!filePath) {
      return undefined;
    }
    const data = await fs.readFile(filePath, { encoding: 'utf8' }).catch(() => undefined);
    if (!data) {
      return undefined;
    }
    const parsed = await xml2js.parseStringPromise(data, { explicitArray: false }).catch(() => undefined);
    if (!parsed) {
      return undefined;
    }
    const rootTag = Object.keys(parsed)[0];
    const value = parsed[rootTag]?.[fieldName];
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Resolves <relativePath> against each package directory in turn, returning the first path that
   * exists on disk, or undefined if none of them have it.
   */
  private async findPackageFile(relativePath: string): Promise<string | undefined> {
    const packageDirectories = await this.getPackageDirectories();
    for (const pkgDir of packageDirectories) {
      const candidate = path.join(pkgDir.path, relativePath);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Resolves the current SfProject's packageDirectories, shared by findPackageFile and the LWR
   * regex scan below.
   */
  // eslint-disable-next-line class-methods-use-this
  private async getPackageDirectories(): Promise<PackageDir[]> {
    const project = await SfProject.resolve();
    return (await project.resolveProjectConfig()).packageDirectories as PackageDir[];
  }

  /**
   * Walks the MetadataComponentDependency graph upward from the given LWC names (the
   * dependency/child side, RefMetadataComponentName) to find every "referencer" that's actually
   * placed on an Experience Cloud page:
   *  - ExperienceBundle referencer -> the site is already identified (Case A: Aura).
   *  - DigitalExperience referencer -> the RefMetadataComponentName of that terminal row is the
   *    root LWC placed on the LWR page; its site still needs to be resolved via regex (Case B).
   *  - LightningComponentBundle referencer -> not a terminal, becomes part of the next hop.
   *  - anything else (QuickAction, FlexiPage, ...) -> dead end, ignored.
   */
  private resolveDependencyRoots(
    adjacency: Map<string, MetadataComponentDependencyRow[]>,
    seedLwcNames: string[]
  ): DependencyRoots {
    const directSiteNames = new Set<string>();
    const lwrRootLwcNames = new Set<string>();
    const visited = new Set<string>(seedLwcNames);
    let frontier = new Set<string>(seedLwcNames);
    let depth = 0;

    while (frontier.size > 0 && depth < MAX_TRAVERSAL_DEPTH) {
      const nextFrontier = new Set<string>();

      for (const lwcName of frontier) {
        const rows = adjacency.get(lwcName) ?? [];
        for (const row of rows) {
          if (row.MetadataComponentType === 'ExperienceBundle') {
            directSiteNames.add(row.MetadataComponentName);
          } else if (row.MetadataComponentType === 'DigitalExperience') {
            lwrRootLwcNames.add(row.RefMetadataComponentName);
          } else if (
            row.MetadataComponentType === 'LightningComponentBundle' &&
            !visited.has(row.MetadataComponentName)
          ) {
            visited.add(row.MetadataComponentName);
            nextFrontier.add(row.MetadataComponentName);
          }
        }
      }

      frontier = nextFrontier;
      depth += 1;
    }

    if (frontier.size > 0) {
      this.warn(messages.getMessage('warning.maxDepthReached', [[...frontier].join(', ')]));
    }

    return { directSiteNames, lwrRootLwcNames };
  }

  /**
   * Fetches the full MetadataComponentDependency graph of "referencers of any
   * LightningComponentBundle" in a single Tooling query (paginated via queryMore when the org has
   * more rows than fit in one page). RefMetadataComponentName is documented as filterable but is
   * not reliably filterable in practice on this table, so no name-based WHERE clause is used --
   * this mirrors the working reference query in ai/metadata_deps.soql, which filters only on the
   * (filterable) RefMetadataComponentType field.
   */
  // eslint-disable-next-line class-methods-use-this
  private async queryAllLwcReferencerRows(connection: Connection): Promise<MetadataComponentDependencyRow[]> {
    const soql =
      'SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentName ' +
      'FROM MetadataComponentDependency ' +
      "WHERE RefMetadataComponentType = 'LightningComponentBundle'";
    const rows: MetadataComponentDependencyRow[] = [];
    let result = await connection.tooling.query<MetadataComponentDependencyRow>(soql);
    rows.push(...(result.records ?? []));
    while (!result.done && result.nextRecordsUrl) {
      // eslint-disable-next-line no-await-in-loop
      const more = await connection.tooling.queryMore(result.nextRecordsUrl);
      rows.push(...((more.records ?? []) as unknown as MetadataComponentDependencyRow[]));
      result = { ...result, done: more.done, nextRecordsUrl: more.nextRecordsUrl };
    }
    return rows;
  }

  /**
   * Builds an in-memory adjacency map keyed by RefMetadataComponentName (the child/dependency
   * side), so the upward BFS in resolveDependencyRoots can look up "who references this LWC"
   * without any further org round trips.
   */
  // eslint-disable-next-line class-methods-use-this
  private buildReferencerAdjacency(rows: MetadataComponentDependencyRow[]): Map<string, MetadataComponentDependencyRow[]> {
    const adjacency = new Map<string, MetadataComponentDependencyRow[]>();
    for (const row of rows) {
      const bucket = adjacency.get(row.RefMetadataComponentName);
      if (bucket) {
        bucket.push(row);
      } else {
        adjacency.set(row.RefMetadataComponentName, [row]);
      }
    }
    return adjacency;
  }

  /**
   * Case B (LWR): for each root LWC placed directly on a Digital Experience page, scans every
   * .json file under any <packageDir>/digitalExperiences/site/<siteFolder>/... path for a
   * `c:<lwcName>` reference (the way LWR pages/views record their root component's api name), and
   * returns the set of matching site folder names (the value later used as Site.Name).
   */
  private async resolveLwrSiteNames(lwrRootLwcNames: Set<string>): Promise<Set<string>> {
    const siteNames = new Set<string>();
    if (lwrRootLwcNames.size === 0) {
      return siteNames;
    }

    const project = await SfProject.resolve();
    const packageDirectories = (await project.resolveProjectConfig()).packageDirectories as PackageDir[];

    for (const pkgDir of packageDirectories) {
      const siteFiles = this.findDigitalExperienceSiteFiles(pkgDir.path);
      for (const { filePath, siteFolder } of siteFiles) {
        // eslint-disable-next-line no-await-in-loop
        const content: string = await fs.readFile(filePath, { encoding: 'utf8' }).catch(() => '');
        for (const lwcName of lwrRootLwcNames) {
          const pattern = new RegExp(`c:${lwcName}(?![A-Za-z0-9_])`);
          if (pattern.test(content)) {
            siteNames.add(siteFolder);
          }
        }
      }
    }

    return siteNames;
  }

  /**
   * Recursively finds every .json file under <baseDir>/.../digitalExperiences/site/<siteFolder>/...
   * and returns each file's path along with the immediate site folder name (the path segment
   * directly under "digitalExperiences/site/").
   */
  // eslint-disable-next-line class-methods-use-this
  private findDigitalExperienceSiteFiles(baseDir: string): Array<{ filePath: string; siteFolder: string }> {
    const results: Array<{ filePath: string; siteFolder: string }> = [];
    if (!fs.existsSync(baseDir)) {
      return results;
    }

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && fullPath.endsWith('.json')) {
          const normalized = fullPath.split(path.sep).join('/');
          const match = /\/digitalExperiences\/site\/([^/]+)\//.exec(normalized);
          if (match) {
            results.push({ filePath: fullPath, siteFolder: match[1] });
          }
        }
      }
    };
    walk(baseDir);

    return results;
  }

  /**
   * Resolves the Network/Community display name (Site.MasterLabel) for each resolved Site.Name.
   * Chunked to stay under SOQL statement-length limits.
   */
  // eslint-disable-next-line class-methods-use-this
  private async querySiteMasterLabels(connection: Connection, siteNames: Set<string>): Promise<string[]> {
    const names = [...siteNames];
    const masterLabels = new Set<string>();
    for (let i = 0; i < names.length; i += SOQL_BATCH_SIZE) {
      const batch = names.slice(i, i + SOQL_BATCH_SIZE).map((n) => `'${n.replace(/'/g, "\\'")}'`);
      const soql = `SELECT Name, MasterLabel FROM Site WHERE Name IN (${batch.join(',')})`;
      // eslint-disable-next-line no-await-in-loop
      const result = await connection.query<SiteRecord>(soql);
      for (const record of result.records ?? []) {
        if (record.MasterLabel) {
          masterLabels.add(record.MasterLabel);
        }
      }
    }
    return [...masterLabels];
  }

  /**
   * Renders the final "Publish Results" summary table, one row per community, with a colored
   * Result column (green Succeeded / red Failed / yellow Timed Out).
   */
  private renderPublishResultsTable(jobs: CommunityPublishJobResult[]): void {
    this.logHuman('');
    this.table(
      jobs.map((job) => ({
        Name: job.name,
        JobId: job.jobId ?? '-',
        Status: job.status ?? '-',
        Result: this.formatResult(job),
      })),
      {
        Name: { header: 'NAME' },
        JobId: { header: 'JOB ID' },
        Status: { header: 'STATUS' },
        Result: { header: 'RESULT' },
      }
    );
  }

  /**
   * Formats a job's outcome as a colored label for display in the results table.
   */
  private formatResult(job: CommunityPublishJobResult): string {
    if (job.timedOut) {
      return colors.yellow('Timed Out');
    }
    if (job.status === 'Error') {
      return colors.red('Failed');
    }
    return colors.green('Succeeded');
  }

  /**
   * Formats a millisecond duration the same way "sf project retrieve start" does: plain
   * milliseconds under one second, otherwise seconds with two decimals (e.g. "4ms", "1.34s").
   */
  private formatElapsed(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
  }

  /**
   * Logs a human-readable progress/status line, but only when --json is not in effect. The
   * command's return value (CommunityPublishResult) is what gets emitted as JSON output by the
   * SfCommand framework, so these narrative lines must be suppressed to keep --json output
   * clean and parseable (this.log() itself is not auto-suppressed by SfCommand, unlike
   * this.spinner/this.table/this.styledHeader).
   */
  private logHuman(message: string): void {
    if (!this.jsonEnabled()) {
      this.log(message);
    }
  }
}
// __________________________GenAI: Generated code ends here______________________________