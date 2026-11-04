"""Asynchronous topology deployment with lock-free progress snapshots."""
from threading import Thread
from uuid import uuid4

from flask_restful import reqparse

from .Endpoint import Endpoint


class DeployTopology(Endpoint):
    def post(self):
        parser = reqparse.RequestParser()
        parser.add_argument('topology_file', required=True, type=str)
        args = parser.parse_args()
        runner = self.netsim
        if not runner.operation_lock.acquire(blocking=False):
            return {'error': 'Another network operation is running'}, 409
        try:
            candidate = runner.read_topology_file(args.topology_file)
        except Exception as failure:
            runner.operation_lock.release()
            if isinstance(failure, (ValueError, OSError)):
                return {'error': f'Invalid topology: {failure}'}, 400
            raise
        deployment_id = uuid4().hex
        job = {'deployment_id': deployment_id, 'status': 'pending', 'switches': {}}
        # Bound history without discarding a currently executing job.
        while len(runner.deployment_jobs) >= 20:
            del runner.deployment_jobs[next(iter(runner.deployment_jobs))]
        runner.deployment_jobs[deployment_id] = job

        def deploy():
            replacement_started = False
            try:
                with runner.lifecycle_lock:
                    job['status'] = 'running'
                    self.ws.close_clis()
                    replacement_started = True
                    runner.topo_file = args.topology_file
                    runner.run(candidate=candidate)
                    try:
                        self.ws.init_clis()
                    except Exception as failure:
                        job['warnings'] = ['Terminals could not be initialized: ' + str(failure)]
                    job['topology'] = runner.topology_state(include_switches_online=True)
                    job['switches'] = dict(runner.deployment.get('switches', {}))
                    job['status'] = 'ready'
            except Exception as failure:
                if replacement_started:
                    runner.topo_file = None
                job.update(status='failed', error=str(failure), switches=dict(runner.deployment.get('switches', {})))
            finally:
                runner.operation_lock.release()

        try:
            Thread(target=deploy, daemon=True, name=f'topology-{deployment_id[:8]}').start()
        except Exception:
            del runner.deployment_jobs[deployment_id]
            runner.operation_lock.release()
            raise
        return {'deployment_id': deployment_id, 'status': 'pending'}, 202


class DeploymentStatus(Endpoint):
    def get(self, deployment_id):
        job = self.netsim.deployment_jobs.get(deployment_id)
        if job is None:
            return {'error': 'Unknown deployment'}, 404
        snapshot = dict(job)
        if snapshot['status'] == 'running':
            snapshot['switches'] = dict(self.netsim.deployment.get('switches', {}))
        return snapshot, 200
