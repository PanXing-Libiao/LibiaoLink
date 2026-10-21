"""Shared upload limits; large STEP jobs keep their separate resource policy."""
import os

MIB=1024*1024
SYNC_INPUT_BYTES=64*MIB
MAX_STEP_INPUT_BYTES=256*MIB

def step_job_input_bytes():
    # Admission policy, not an RSS prediction or completion guarantee.
    # Larger inputs require an explicit operator override after checking resources.
    value=int(os.environ.get('CAD_STEP_MAX_INPUT_MIB','64'))
    if not 1<=value<=256:raise ValueError('CAD_STEP_MAX_INPUT_MIB must be between 1 and 256')
    return value*MIB

def worker_input_bytes():
    value=int(os.environ.get('CAD_STEP_INPUT_BYTES',str(SYNC_INPUT_BYTES)))
    if not 1<=value<=MAX_STEP_INPUT_BYTES:raise ValueError('invalid STEP worker input budget')
    return value

def upload_limits():
    return {'version':'cad-input-policy/2','synchronousInputBytes':SYNC_INPUT_BYTES,
            'stepJobInputBytes':step_job_input_bytes()}
