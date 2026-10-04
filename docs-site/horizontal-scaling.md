# Horizontal scaling

Run the API as stateless replicas behind a load balancer. Configure `STORAGE_DRIVER=s3` so every node shares cache and batch objects, and set `CACHE_DISTRIBUTED_LOCK_ENABLED=true` with the same Redis `REDIS_URL` on every replica to coalesce concurrent cold-cache transforms. Disk storage is local to one node. Redis lock failures fail open; BullMQ also uses Redis when its queue is enabled.

The full [horizontal scaling architecture and Mermaid diagram](https://github.com/erolsenol/image-craft-service/blob/master/docs/horizontal-scaling.md) covers lock behavior, Redis/S3 operations, consistent-hash routing, HPA, and capacity limits. Its [load-test report](https://github.com/erolsenol/image-craft-service/blob/master/docs/load-test-report.md) includes commands for 1k, 5k, and 10k RPS. Measured figures are intentionally unreported until those workloads run on a multi-node deployment.

Enable the Helm HPA with `autoscaling.enabled=true`; install Metrics Server and tune CPU/memory requests and limits using the documented load procedure. See [Deployment](./deployment) for the base chart and Kubernetes setup.
