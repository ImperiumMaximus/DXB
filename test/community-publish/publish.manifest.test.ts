// _______________This Code was generated using GenAI tool : Codify, Please check for accuracy_______________
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import * as path from 'node:path';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Config } from '@oclif/core';
import { SfProject } from '@salesforce/core';
import { Connection } from 'jsforce';
import CommunityPublish from '../../src/commands/dxb/community/publish';

/*
 * Offline unit tests for the `dxb community publish --manifest` delta-resolution pipeline.
 * No live org is used: jsforce.Connection and SfProject.resolve() are stubbed, and real fixture
 * files under fixtures/project/ stand in for the source-format meta.xml/JSON files that
 * parseMetaXmlField/resolveLwrSiteNames read from disk.
 */

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const MANIFESTS_DIR = path.join(FIXTURES_DIR, 'manifests');
const PROJECT_DIR = path.join(FIXTURES_DIR, 'project');
const manifest = (name: string): string => path.join(MANIFESTS_DIR, name);

describe('dxb community publish - manifest resolution (unit)', () => {
  let cmd: any;
  let sandbox: sinon.SinonSandbox;
  let connection: Connection;
  let toolingQueryStub: sinon.SinonStub;
  let toolingQueryMoreStub: sinon.SinonStub;
  let queryStub: sinon.SinonStub;
  let warnSpy: sinon.SinonStub;

  before(async () => {
    const config = await Config.load(process.cwd());
    cmd = new CommunityPublish([], config);
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(SfProject, 'resolve').resolves({
      resolveProjectConfig: async () => ({ packageDirectories: [{ path: PROJECT_DIR }] }),
    } as any);

    toolingQueryStub = sandbox.stub().resolves({ done: true, records: [] });
    toolingQueryMoreStub = sandbox.stub().resolves({ done: true, records: [] });
    queryStub = sandbox.stub().resolves({ records: [] });
    connection = {
      tooling: { query: toolingQueryStub, queryMore: toolingQueryMoreStub },
      query: queryStub,
    } as unknown as Connection;

    warnSpy = sandbox.stub(cmd, 'warn').callsFake((w: unknown) => w);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('extractMembersFromManifest', () => {
    it('parses every <types> block into a Map of type -> members[]', async () => {
      const result: Map<string, string[]> = await cmd.extractMembersFromManifest(
        manifest('combo-lwc-and-customsite.xml')
      );
      expect(result.get('LightningComponentBundle')).to.deep.equal(['b2b_lcp_customAddToCart']);
      expect(result.get('CustomSite')).to.deep.equal(['LegacySite']);
    });

    it('returns an empty Map for a manifest with no <types> blocks', async () => {
      const result: Map<string, string[]> = await cmd.extractMembersFromManifest(manifest('empty.xml'));
      expect(result.size).to.equal(0);
    });
  });

  describe('resolveDirectMetadataNames - one case per direct metadata type', () => {
    it('Network: uses the member name verbatim, no file read, no Site query needed', async () => {
      const membersByType = await cmd.extractMembersFromManifest(manifest('network.xml'));
      const { siteNameCandidates, directCommunityNames } = await cmd.resolveDirectMetadataNames(membersByType);
      expect([...directCommunityNames]).to.deep.equal(['MyCommunity']);
      expect(siteNameCandidates.size).to.equal(0);
    });

    it('ExperienceBundle: reads sibling site-meta.xml <label> into siteNameCandidates', async () => {
      const membersByType = await cmd.extractMembersFromManifest(manifest('experiencebundle.xml'));
      const { siteNameCandidates, directCommunityNames } = await cmd.resolveDirectMetadataNames(membersByType);
      expect([...siteNameCandidates]).to.deep.equal(['My Store']);
      expect(directCommunityNames.size).to.equal(0);
    });

    it('DigitalExperienceBundle: reads the nested bundle descriptor <label> into siteNameCandidates', async () => {
      const membersByType = await cmd.extractMembersFromManifest(manifest('digitalexperiencebundle.xml'));
      const { siteNameCandidates } = await cmd.resolveDirectMetadataNames(membersByType);
      expect([...siteNameCandidates]).to.deep.equal(['B2B Store']);
    });

    it('DigitalExperienceBundle: falls back to the bundle name and warns when the descriptor file is missing', async () => {
      const membersByType = await cmd.extractMembersFromManifest(manifest('digitalexperiencebundle-missing.xml'));
      const { siteNameCandidates } = await cmd.resolveDirectMetadataNames(membersByType);
      expect([...siteNameCandidates]).to.deep.equal(['ghostSite']);
      expect(warnSpy.calledOnce).to.equal(true);
      expect(String(warnSpy.firstCall.args[0])).to.include('DigitalExperienceBundle');
    });

    it('DigitalExperienceConfig: reads <label> into directCommunityNames (no Site query needed)', async () => {
      const membersByType = await cmd.extractMembersFromManifest(manifest('digitalexperienceconfig.xml'));
      const { siteNameCandidates, directCommunityNames } = await cmd.resolveDirectMetadataNames(membersByType);
      expect([...directCommunityNames]).to.deep.equal(['My Config']);
      expect(siteNameCandidates.size).to.equal(0);
    });

    it('CustomSite: reads <masterLabel> into directCommunityNames', async () => {
      const membersByType = await cmd.extractMembersFromManifest(manifest('customsite.xml'));
      const { directCommunityNames } = await cmd.resolveDirectMetadataNames(membersByType);
      expect([...directCommunityNames]).to.deep.equal(['Legacy Site']);
    });

    it('SiteDotCom: reads <label> into directCommunityNames', async () => {
      const membersByType = await cmd.extractMembersFromManifest(manifest('sitedotcom.xml'));
      const { directCommunityNames } = await cmd.resolveDirectMetadataNames(membersByType);
      expect([...directCommunityNames]).to.deep.equal(['Old Site']);
    });

    it('CustomSite: skips the member entirely and warns once when its file is missing', async () => {
      const membersByType = await cmd.extractMembersFromManifest(manifest('customsite-missing.xml'));
      const { siteNameCandidates, directCommunityNames } = await cmd.resolveDirectMetadataNames(membersByType);
      expect(siteNameCandidates.size).to.equal(0);
      expect(directCommunityNames.size).to.equal(0);
      expect(warnSpy.calledOnce).to.equal(true);
      expect(String(warnSpy.firstCall.args[0])).to.include('CustomSite');
    });
  });

  describe('LWC dependency-graph resolution (getCommunityNamesFromManifest)', () => {
    it('direct hit: LWC referenced directly by an ExperienceBundle', async () => {
      toolingQueryStub.resolves({
        done: true,
        records: [
          {
            MetadataComponentName: 'Capricorn_B2B_Store1',
            MetadataComponentType: 'ExperienceBundle',
            RefMetadataComponentName: 'b2b_lcp_customAddToCart',
          },
        ],
      });
      queryStub.resolves({ records: [{ Name: 'Capricorn_B2B_Store1', MasterLabel: 'Capricorn B2B Store' }] });

      const result: string[] = await cmd.getCommunityNamesFromManifest(manifest('lwc-direct-hit.xml'), connection);
      expect(result).to.deep.equal(['Capricorn B2B Store']);
      expect(toolingQueryStub.calledOnce).to.equal(true);
    });

    it('indirect hit: LWC resolved after a 2-hop transitive walk, still a single upfront fetch', async () => {
      toolingQueryStub.resolves({
        done: true,
        records: [
          {
            MetadataComponentName: 'b2b_lcp_header',
            MetadataComponentType: 'LightningComponentBundle',
            RefMetadataComponentName: 'pubsub',
          },
          {
            MetadataComponentName: 'Capricorn_B2B_Store1',
            MetadataComponentType: 'ExperienceBundle',
            RefMetadataComponentName: 'b2b_lcp_header',
          },
        ],
      });
      queryStub.resolves({ records: [{ Name: 'Capricorn_B2B_Store1', MasterLabel: 'Capricorn B2B Store' }] });

      const result: string[] = await cmd.getCommunityNamesFromManifest(manifest('lwc-indirect-hit.xml'), connection);
      expect(result).to.deep.equal(['Capricorn B2B Store']);
      expect(toolingQueryStub.calledOnce).to.equal(true);
    });

    it('no match: LWC absent from the fetched graph resolves to no communities', async () => {
      toolingQueryStub.resolves({ done: true, records: [] });

      const result: string[] = await cmd.getCommunityNamesFromManifest(manifest('lwc-no-match.xml'), connection);
      expect(result).to.deep.equal([]);
      expect(queryStub.called).to.equal(false);
    });

    it('dead end: LWC referenced only by a QuickAction is ignored (rows exist but lead nowhere)', async () => {
      toolingQueryStub.resolves({
        done: true,
        records: [
          {
            MetadataComponentName: 'RLM_Create_Billing_Schedule_Group',
            MetadataComponentType: 'QuickAction',
            RefMetadataComponentName: 'rlmBillingScheduleGroupModal',
          },
        ],
      });

      const result: string[] = await cmd.getCommunityNamesFromManifest(manifest('lwc-dead-end.xml'), connection);
      expect(result).to.deep.equal([]);
      expect(queryStub.called).to.equal(false);
    });

    it('LWR hit: LWC referenced by a DigitalExperience is resolved via the fixture site JSON scan', async () => {
      toolingQueryStub.resolves({
        done: true,
        records: [
          {
            MetadataComponentName: 'detail_01t--sfdc_cms__view',
            MetadataComponentType: 'DigitalExperience',
            RefMetadataComponentName: 'fln_b2b_productSpecifications',
          },
        ],
      });
      queryStub.resolves({ records: [{ Name: 'b2bstore', MasterLabel: 'B2B Store LWR' }] });

      const result: string[] = await cmd.getCommunityNamesFromManifest(manifest('lwc-lwr-hit.xml'), connection);
      expect(result).to.deep.equal(['B2B Store LWR']);
    });

    it('pagination: queryMore is followed until done, and its rows feed the in-memory BFS', async () => {
      toolingQueryStub.resolves({
        done: false,
        nextRecordsUrl: '/services/data/v59.0/tooling/query/01g-2000',
        records: [
          {
            MetadataComponentName: 'b2b_lcp_header',
            MetadataComponentType: 'LightningComponentBundle',
            RefMetadataComponentName: 'pubsub',
          },
        ],
      });
      toolingQueryMoreStub.resolves({
        done: true,
        records: [
          {
            MetadataComponentName: 'Capricorn_B2B_Store1',
            MetadataComponentType: 'ExperienceBundle',
            RefMetadataComponentName: 'b2b_lcp_header',
          },
        ],
      });
      queryStub.resolves({ records: [{ Name: 'Capricorn_B2B_Store1', MasterLabel: 'Capricorn B2B Store' }] });

      const result: string[] = await cmd.getCommunityNamesFromManifest(manifest('lwc-indirect-hit.xml'), connection);
      expect(result).to.deep.equal(['Capricorn B2B Store']);
      expect(toolingQueryStub.calledOnce).to.equal(true);
      expect(toolingQueryMoreStub.calledOnce).to.equal(true);
    });

    it('safety cap: a never-terminating LightningComponentBundle chain stops at MAX_TRAVERSAL_DEPTH and warns', () => {
      // n1 references n0, n2 references n1, ... n12 references n11: a chain well past the 10-hop
      // cap, so the BFS started from n0 must stop early instead of walking forever.
      const records = Array.from({ length: 12 }, (_, i) => ({
        MetadataComponentName: `n${i + 1}`,
        MetadataComponentType: 'LightningComponentBundle',
        RefMetadataComponentName: `n${i}`,
      }));

      const adjacency = cmd.buildReferencerAdjacency(records);
      const { directSiteNames, lwrRootLwcNames } = cmd.resolveDependencyRoots(adjacency, ['n0']);

      expect(directSiteNames.size).to.equal(0);
      expect(lwrRootLwcNames.size).to.equal(0);
      expect(warnSpy.calledOnce).to.equal(true);
    });
  });

  describe('getCommunityNamesFromManifest - end to end combinations', () => {
    it('combines an LWC-graph hit and a direct CustomSite member into a deduped union', async () => {
      toolingQueryStub.resolves({
        done: true,
        records: [
          {
            MetadataComponentName: 'Capricorn_B2B_Store1',
            MetadataComponentType: 'ExperienceBundle',
            RefMetadataComponentName: 'b2b_lcp_customAddToCart',
          },
        ],
      });
      queryStub.resolves({ records: [{ Name: 'Capricorn_B2B_Store1', MasterLabel: 'Capricorn B2B Store' }] });

      const result: string[] = await cmd.getCommunityNamesFromManifest(
        manifest('combo-lwc-and-customsite.xml'),
        connection
      );
      expect(result.slice().sort()).to.deep.equal(['Capricorn B2B Store', 'Legacy Site'].sort());
    });

    it('returns [] and never queries the org for a manifest with no relevant members', async () => {
      const result: string[] = await cmd.getCommunityNamesFromManifest(manifest('empty.xml'), connection);
      expect(result).to.deep.equal([]);
      expect(toolingQueryStub.called).to.equal(false);
      expect(queryStub.called).to.equal(false);
    });

    it('chunks the Site MasterLabel lookup at SOQL_BATCH_SIZE (200)', async () => {
      const siteNames = new Set<string>(Array.from({ length: 250 }, (_, i) => `Site${i}`));
      queryStub.resolves({ records: [] });

      await cmd.querySiteMasterLabels(connection, siteNames);

      expect(queryStub.callCount).to.equal(2);
    });
  });
});
// __________________________GenAI: Generated code ends here______________________________