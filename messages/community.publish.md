# summary

Publish experience community to target environment. If not specified, then will fetch all "Live" communities from target env.

# examples

- Publish all live communities

  <%= config.bin %> <%= command.id %>

- Publish specific communities

  <%= config.bin %> <%= command.id %> --name portal1 --name partner1

# flags.name.summary

Contains the name of a community. If not specified, then will fetch all "Live" communities from target env

# flags.poll.summary

Wait for the publish job(s) to complete by polling the resulting BackgroundOperation record until its Status is "Complete" or "Error". Communities are always published sequentially; when this flag is set, each community's job is polled to completion before the next community's publish job is submitted, to avoid publish locking errors on the org.

# flags.poll-interval.summary

Interval, in seconds, between polling attempts against the BackgroundOperation record. Only used when --poll is set.

# flags.poll-timeout.summary

Overall timeout, in seconds, after which the command aborts polling for a given community's publish job and reports it as timed out. Only used when --poll is set.

# flags.manifest.summary

Path to a delta package.xml (as produced by "dxb source delta") used to automatically resolve which communities are affected by the LightningComponentBundle members it contains, by walking the org's MetadataComponentDependency graph and, for Digital Experience (LWR) sites, scanning the digitalExperiences/site source for the root component reference. Mutually exclusive with --name. Run this after the delta has been deployed, since MetadataComponentDependency is only populated post-deploy.

# info.noRelevantMembersInManifest

The manifest contains no LightningComponentBundle, ExperienceBundle, DigitalExperienceBundle, DigitalExperienceConfig, Network, CustomSite, or SiteDotCom members; nothing to publish.

# info.resolvingManifestDependencies

Resolving affected communities from %s changed Lightning web component(s)...

# info.resolvedSites

Resolved communities from manifest: %s

# warning.noSitesResolved

No Experience Cloud site could be resolved from the manifest's members; nothing to publish.

# warning.maxDepthReached

Stopped walking the dependency graph after reaching the maximum depth with the following component(s) still unresolved: %s

# warning.metadataFileNotFound

Could not find or parse the source-format file for %s member (expected at %s); skipping it.

# header.title

Publishing Community

# info.publishing

Publishing communities to %s

# log.publishSubmitted

Publish job submitted for community "%s" (BackgroundOperation Id: %s).

# spinner.start.preparing

Preparing publish request

# spinner.stop.preparing

Prepared

# spinner.start.sending

Sending publish request to org

# spinner.stop.sending

Sent

# spinner.start.waiting

Waiting for org to respond

# spinner.stop.waiting.complete

Completed

# spinner.stop.waiting.error

Failed

# spinner.stop.waiting.timeout

Timed out

# spinner.status.polling

current Status: %s

# label.status

Status:

# label.elapsed

Elapsed Time:

# warning.pollTimeout

Timed out waiting for the publish job of community "%s" (BackgroundOperation Id: %s) to complete.

# warning.pollError

Publish job for community "%s" (BackgroundOperation Id: %s) ended with Status "Error".