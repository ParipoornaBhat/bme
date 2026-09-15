# An Explainable and Unified Deep Learning Architecture for Bone Marrow Edema Detection in Magnetic Resonance Imaging (MRI)

**Department of Computer Science and Engineering**

---

## Team Members

| Name | USN | Signature |
| :--- | :--- | :--- |
| Elvin Edwin Rodrigues | NNM23CS071 | |
| Paripoorna B | NNM23CS124 | |
| Reegan Sujal Pinto | NNM23CS149 | |
| Aditi H Nayak | NNM23CS293 | |

---

## Guide Information

1. Dr. Shashank Shetty
2. Dr. Puneeth R P.

---

## Introduction

Bone marrow edema (BME) is a significant MRI finding commonly associated with musculoskeletal conditions such as trauma, osteoarthritis, and inflammatory diseases. MRI, particularly T2-weighted and STIR sequences, is highly effective for detecting BME. However, manual interpretation of MRI scans is time-consuming and can vary between radiologists, leading to inconsistent results. With recent advances in artificial intelligence and deep learning, automated analysis of medical images has become possible. This project focuses on developing an AI-based system for the automatic detection of bone marrow edema from MRI scans to enhance diagnostic accuracy and clinical efficiency.

---

## Problem Statement

Manual detection of Bone Marrow Edema from MRI images depends heavily on radiologist expertise and may lead to inconsistent diagnosis, particularly in early disease stages. Increasing MRI workloads further reduce clinical efficiency. Traditional image processing methods are not robust enough to handle variations in image quality and anatomy. Therefore, an automated AI-based solution is required for reliable detection of Bone Marrow Edema.

---

## Literature Survey

Recent studies in medical image analysis have demonstrated the effectiveness of convolutional neural networks (CNNs) for musculoskeletal MRI interpretation. U-Net and its variants are widely used for biomedical image segmentation due to their ability to preserve spatial features. Both 2D and 3D deep learning models have been explored for detecting bone marrow lesions, with 3D models providing better volumetric context at the cost of higher computational complexity. Despite promising results, existing methods often suffer from limited generalization due to dataset imbalance, small sample sizes, and variations in MRI scanners and imaging protocols, highlighting the need for more robust automated solutions.

---

## Objectives

- To design and develop a unified deep learning framework for fully automated and explainable detection of bone marrow edema from MRI images, enabling robust identification of pathological patterns beyond manual visual assessment.
- To accurately localize and segment bone marrow edema regions using advanced representation learning and explainable image analysis techniques, ensuring transparency, clinical interpretability, and trust in AI-driven decisions.
- To establish clinical-grade reliability via rigorous performance benchmarking and workflow efficiency analysis.
- To develop a cloud-enabled, explainable AI-powered web platform for real-time MRI-based bone marrow edema detection, facilitating seamless integration into clinical workflows.
