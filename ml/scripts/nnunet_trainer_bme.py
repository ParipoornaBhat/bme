"""nnU-Net trainer for the H200: 100 epochs, a checkpoint every 5 epochs.

nnU-Net's own trainers write checkpoint_latest every 50 epochs. A job on the
H200 is stopped at 4 h, so each resume could lose up to 49 epochs. With this
trainer a resume loses at most 4.

nnU-Net finds trainers by class name inside its own package, so
ml/slurm/nnunet.sbatch copies this file into the nnunetv2 installed in ~/bme/env.
"""

from nnunetv2.training.nnUNetTrainer.variants.training_length.nnUNetTrainer_Xepochs import nnUNetTrainer_100epochs


class nnUNetTrainer_BME100(nnUNetTrainer_100epochs):
    def initialize(self):
        self.save_every = 5
        super().initialize()
