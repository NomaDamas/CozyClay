#!/bin/bash
#SBATCH --job-name=cozyclay-gen
#SBATCH --partition=interactive
#SBATCH --gres=gpu:1
#SBATCH --nodelist=gpu03
#SBATCH --cpus-per-task=16
#SBATCH --mem=120G
#SBATCH --time=12:00:00
#SBATCH --output=logs/%x-%j.log

# cozyclay-gen: headless MiniMax-H3 service (ComfyUI as a library, no ComfyUI server/UI)
# ---- site config (edit these or export them before sbatch) ----
export COZYCLAY_GEN_DIR=${COZYCLAY_GEN_DIR:-$HOME/cozyclay-gen}     # this directory
export COMFY_ROOT=${COMFY_ROOT:-$HOME/ComfyUI}                        # ComfyUI checkout (used as a library)
export COMFY_DATA=${COMFY_DATA:-$HOME/comfy-data}                     # models/ input/ output/ user/ live here
export HF_HOME=${HF_HOME:-$HOME/.cache/huggingface}
mkdir -p "$COZYCLAY_GEN_DIR/logs" "$COMFY_DATA/output/cozyclay"
cd "$COZYCLAY_GEN_DIR"
source "$COMFY_ROOT/.venv/bin/activate"
PORT=${PORT:-8288}
echo "COZYCLAY_GEN_NODE=$(hostname) PORT=$PORT"

# partition MaxTime is 12h: queue a successor that starts when this job ends (timeout or crash),
# so the service is always up. To stop for good: scancel --name=cozyclay-gen (kills running + pending).
if [ "${COZYCLAY_GEN_CHAIN:-1}" = "1" ]; then
  SBATCH_BIN=$(command -v sbatch || ls /usr/bin/sbatch /usr/local/bin/sbatch /opt/slurm/bin/sbatch 2>/dev/null | head -1)
  if [ -n "$SBATCH_BIN" ]; then
    "$SBATCH_BIN" --quiet --dependency=afterany:$SLURM_JOB_ID "$COZYCLAY_GEN_DIR/cozyclay-gen.sbatch" && echo "queued successor"
  else
    # compute nodes have no sbatch: queue it on the slurm controller (login node) over ssh.
    # key: ~/.ssh/cluster_chain (home is NFS-shared; pubkey is in authorized_keys)
    # set COZYCLAY_GEN_SUBMIT_HOST (user@host) and COZYCLAY_GEN_SUBMIT_KEY (ssh key) if compute nodes cannot run sbatch
    if [ -n "${COZYCLAY_GEN_SUBMIT_HOST:-}" ]; then
      ssh -i "${COZYCLAY_GEN_SUBMIT_KEY:-$HOME/.ssh/id_ed25519}" -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${COZYCLAY_GEN_SUBMIT_PORT:+-p $COZYCLAY_GEN_SUBMIT_PORT} "$COZYCLAY_GEN_SUBMIT_HOST" \
        "sbatch --quiet --dependency=afterany:$SLURM_JOB_ID $COZYCLAY_GEN_DIR/cozyclay-gen.sbatch" \
        && echo "queued successor via controller" || echo "WARN: could not queue successor; resubmit manually before the time limit"
    else
      echo "WARN: no sbatch on this node and COZYCLAY_GEN_SUBMIT_HOST unset; resubmit manually before the time limit"
    fi
  fi
fi

# auto-purge generated clips older than 60 min, every 5 min (no prompt metadata is written anyway)
(
  while true; do
    find "$COMFY_DATA/output/cozyclay" -type f -mmin +60 -delete 2>/dev/null
    find /tmp -maxdepth 1 -name 'ccgen_*' -type d -mmin +60 -exec rm -rf {} + 2>/dev/null
    sleep 300
  done
) &

exec python server.py --host 0.0.0.0 --port $PORT
