# arXiv 检索报告

| 项目 | 值 |
| --- | --- |
| 查询式 | `all:"large language model" AND cat:cs.LG AND submittedDate:[202609240000 TO 999912312359]` |
| 生成时间 | 2026-10-04 02:52 |
| 索引命中总数 | 286 |
| 本次获取 | 12 条 / 1 页 |
| 排序 | submittedDate descending |
| 耗时 | 1.00 s |
| 结果条数 | 12 |

## 概览统计

### 分类分布（Top 6）

| 分类 | 数量 | 占比 | |
| --- | ---: | ---: | --- |
| `cs.LG` | 12 | 100% | `████████████████████████` |
| `cs.CL` | 7 | 58.3% | `██████████████` |
| `cs.AI` | 6 | 50% | `████████████` |
| `cs.CV` | 1 | 8.3% | `██` |
| `cs.SE` | 1 | 8.3% | `██` |
| `math.OC` | 1 | 8.3% | `██` |

### 标签共现（Top 8）

- cs.CL + cs.LG — 7 篇
- cs.AI + cs.LG — 6 篇
- cs.AI + cs.CL — 5 篇
- cs.AI + cs.CV — 1 篇
- cs.CL + cs.CV — 1 篇
- cs.CV + cs.LG — 1 篇
- cs.LG + cs.SE — 1 篇
- cs.LG + math.OC — 1 篇

### 时间分布（按月）

| 区间 | 数量 | |
| --- | ---: | --- |
| 2026-10 | 12 | `████████████████` |

### 高频主题词（TF-IDF）

`llm`、`learning`、`language`、`large`、`reasoning`、`post-training`、`training`、`updates`、`analysis`、`weight`、`bias`、`knowledge`、`latent`、`mathematical`、`prediction`、`reduce`、`reinforcement`、`scalable`、`self-distillation`、`absolute-max`

> 权重分值（TF-IDF）：llm=13.979, learning=12.085, language=11.09, large=11.09, reasoning=11.014, post-training=8.318, training=8.318, updates=8.318, analysis=8.047, weight=8.047, bias=7.784, knowledge=7.784

### 主题聚类（k=4）

**簇 1**（5 篇）— 关键词：`distributions` `test-time` `adaptation` `access` `source` `developing`
  - TACO: Ternary Absolute-max Column-wise One-sparse Optimizer for LLM Fine-Tuning
  - From Knowledge Access to Source Learning: Developing Source-Specific Competence
  - Where-OPD: Spatially Guided On-Policy Self-Distillation of MLLMs with Synthetic Scenes
  - …其余 2 篇

**簇 2**（4 篇）— 关键词：`primitive` `diagnosing` `mathematical` `asynchronous` `capping` `convergence`
  - The Missing Primitive: Diagnosing and Repairing Mathematical Reasoning in Large Language Models
  - CARM: Cancellation-Aware Response Masking for LLM Reinforcement Learning
  - FastCI: Efficient GPU-Intensive CI for LLM Training Frameworks
  - …其余 1 篇

**簇 3**（2 篇）— 关键词：`jepa` `abstract` `future` `prediction` `counterfactual` `auditing`
  - Counterfactual Auditing of Bias in Open-Source Large Language Models for Clinical Triage
  - Latent JEPA: Abstract Future Prediction for Latent Reasoning in Chemistry

**簇 4**（1 篇）— 关键词：`transferable` `selection` `scalable` `meta-network` `obvious` `choice`
  - Scalable, Transferable Meta-network for Data Selection Requires a Different Loss (and Why the Obvious Choice …

### 结构化摘要

检出结构化摘要的论文：0 / 12

## 结果列表

### 1. TACO: Ternary Absolute-max Column-wise One-sparse Optimizer for **LLM** Fine-Tuning

- Jichao Jiang, Cristian McGee, El Houcine Bergou, Hanqin Cai, Aritra Dutta
- 2026-10-01 ｜ arXiv:2610.02199 ｜ cs.LG, math.OC
- 备注：24 pages, 7 figures, 10 tables. Code available at https://github.com/Jichao2357/TACO_optimizer
- 链接：https://arxiv.org/abs/2610.02199v1 ｜ PDF：https://arxiv.org/pdf/2610.02199v1

> Full-parameter fine-tuning of **large** **language** models (LLMs) incurs substantial optimizer state memory overhead, limiting the model sizes that fit on modern GPUs. Existing approaches either compress optimizer state, abandon first-order gradients, or change the update geometry while retaining dense state. The recently introduced Muon optimizer reduces optimizer memory through matrix-valued **updates**. Still, its geometry differs from AdamW and can lead to performance degradation when fine-tuning AdamW-pretrained models. To reduce optimizer memory without sacrificing accuracy or computational efficiency in **LLM** fine-tuning, we propose Ternary Absolute-max Column-wise One-sparse opti…


### 2. The Missing Primitive: Diagnosing and Repairing Mathematical **Reasoning** in **Large** **Language** Models

- Shuo Xing, Zilin Dai, Chengyuan Qian, Fangzhou Lin, Wenjing Chen et al.
- 2026-10-01 ｜ arXiv:2610.02191 ｜ cs.LG
- 备注：27 pages
- 链接：https://arxiv.org/abs/2610.02191v1 ｜ PDF：https://arxiv.org/pdf/2610.02191v1

> While **Large** **Language** Models (LLMs) have demonstrated striking capabilities on frontier mathematical problems, it remains unclear whether they possess the structural mathematical understanding underlying their solutions. In this paper, we take a first step toward systematically studying mathematical understanding in LLMs, from diagnosing its distinct capabilities to leveraging these findings to improve **post-training**. First, we introduce the notion of Mathematical Primitive to probe structural mathematical understanding and propose \hlei{}, a novel benchmark that evaluates mathematical **reasoning** along four distinct dimensions: Discovery, Generation, Digestion, and Execution. S…


### 3. From Knowledge Access to Source **Learning**: Developing Source-Specific Competence

- Lucheng Fu, Kejing Xia, Yiyang Wang, Yiqiao Jin, Jinjin He et al.
- 2026-10-01 ｜ arXiv:2610.02150 ｜ cs.CL, cs.AI, cs.LG
- 备注：Website: https://sourcelearn.github.io/ Code: https://github.com/luchengfu6/SourceLearn
- 链接：https://arxiv.org/abs/2610.02150v1 ｜ PDF：https://arxiv.org/pdf/2610.02150v1

> **Large** **language** model (**LLM**) agents increasingly rely on persistent external sources to solve sequences of knowledge-intensive tasks. Existing methods improve how source content is accessed and organized, while agent-memory systems preserve reusable knowledge from prior interactions, but repeated use of the same source is still largely treated as repeated access rather than an opportunity to progressively improve understanding of that source. We study source **learning**: developing reusable source-specific competence over a persistent authoritative source. We represent this competence with a persistent source model that captures reusable understanding of the source, including how…


### 4. Where-OPD: Spatially Guided On-Policy Self-Distillation of MLLMs with Synthetic Scenes

- Sophia Sirko-Galouchenko, Monika Wysoczanska, Andrei Bursuc, Nicolas Thome, Spyros Gidaris
- 2026-10-01 ｜ arXiv:2610.02117 ｜ cs.CV, cs.AI, cs.CL, cs.LG
- 链接：https://arxiv.org/abs/2610.02117v1 ｜ PDF：https://arxiv.org/pdf/2610.02117v1

> On-policy self-distillation has recently emerged as an effective approach for improving **language**-model **reasoning** by supervising students with a frozen or EMA version of themselves that receives privileged information. Its application to multimodal **large** **language** models (MLLMs), however, remains largely unexplored. Recent approaches use privileged visual information, such as image crops corresponding to a question, to improve fine-grained perception, but their gains are confined to tasks that benefit from such visual zooming and require either human-annotated grounding data or external teacher models. We introduce a different form of on-policy self-distillation for MLLMs that…


### 5. Scalable, Transferable Meta-network for Data Selection Requires a Different Loss (and Why the Obvious Choice is Problematic)

- Zilin Du, Bowen Yang, Boyang Albert Li
- 2026-10-01 ｜ arXiv:2610.02092 ｜ cs.CL, cs.AI, cs.LG
- 链接：https://arxiv.org/abs/2610.02092v1 ｜ PDF：https://arxiv.org/pdf/2610.02092v1

> Data selection is critical for **training** **large** **language** models on massive and heterogeneous corpora. Meta-**learning** for **Training**-data Selection offers a principled alternative to heuristic scoring by **learning** data weights from a target validation objective, but existing methods face a trade-off between fine-grained valuation and transferability to unseen data. A natural solution is to replace per-sample weights with a selection network. However, we find that directly incorporating such a network into existing MTS objectives leads to unstable optimization and poor generalization, caused by **weight** suppression and persistent reliance on easy-to-learn features. To addr…


### 6. CARM: Cancellation-Aware Response Masking for **LLM** Reinforcement **Learning**

- Yafei Zhang, Songshuo Lu, Sicong Liao, Zhi Chen, Yaohua Tang
- 2026-10-01 ｜ arXiv:2610.02039 ｜ cs.LG, cs.AI, cs.CL
- 备注：28 pages, 11 figures, 5 tables
- 链接：https://arxiv.org/abs/2610.02039v1 ｜ PDF：https://arxiv.org/pdf/2610.02039v1

> Recent years have witnessed the rapid adoption of reinforcement **learning** (RL) in **large** **language** model (**LLM**) **post-training**, with substantial gains in mathematical **reasoning** and code generation. In practical systems, however, policy **updates** and differences between rollout and **training** engines can make sampled responses off-policy. Sequence-level masking addresses this mismatch by deciding whether an entire response should contribute to optimization. A common masking rule uses the length-normalized geometric mean of sampled token probability ratios. Its signed log-ratios can cancel across positions, concealing substantial bidirectional policy drift. We propose \…


### 7. Universal Byte-Level Encoding: UTF-8/UTF-16 Routing to Reduce Cross-Script Token-Budget Disparities

- Hyunsik Kim, Youngmoon Jung
- 2026-10-01 ｜ arXiv:2610.01984 ｜ cs.CL, cs.LG
- 备注：Accepted to NeurIPS 2026
- 链接：https://arxiv.org/abs/2610.01984v1 ｜ PDF：https://arxiv.org/pdf/2610.01984v1

> Byte-level byte-pair encoding (BBPE) tokenizers are attractive for multilingual **large** **language** models (LLMs) because they cover all Unicode text. In UTF-8-based BBPE, however, many scripts start from a higher fallback cost than English: when no learned merges can be applied, a multibyte character requires multiple byte-derived symbols. We call this worst-case pre-merge cost the encoding floor. A higher floor can increase token counts and per-request cost and shrink usable context. Changing the text encoding can reduce this gap, but a single global encoding can make already-efficient English spans more expensive in mixed-script text. We propose Universal Byte-Level Encoding (UBE), a …


### 8. FastCI: Efficient GPU-Intensive CI for **LLM** **Training** Frameworks

- Tianshuo Qiao, Naiqian Zheng, Xiaopeng Liu, Shuguang Wang, Diandian Gu et al.
- 2026-10-01 ｜ arXiv:2610.01967 ｜ cs.LG, cs.SE
- 链接：https://arxiv.org/abs/2610.01967v1 ｜ PDF：https://arxiv.org/pdf/2610.01967v1

> As **large** **language** models (LLMs) keep growing in size and complexity, their **training** frameworks evolve at a rapid pace as well. Therefore, continuous integration (CI) is critical for maintaining the quality and stability of these frameworks. However, unlike traditional software, CI for **LLM** **training** frameworks relies on GPU-intensive tests, which usually involve complete model **training** or evaluation. This leads CI itself to become a new bottleneck for fast-paced development. In this paper, we introduce FastCI, a framework that improves the efficiency of CI for **LLM** **training** frameworks. FastCI leverages runtime evidence to select affected tests and prune tests th…


### 9. Counterfactual Auditing of Bias in Open-Source **Large** **Language** Models for Clinical Triage

- Manar Aljohani, Brandon Ho, Kenneth McKinley, Dennis Ren, Xuan Wang
- 2026-10-01 ｜ arXiv:2610.01963 ｜ cs.AI, cs.CL, cs.LG
- 链接：https://arxiv.org/abs/2610.01963v1 ｜ PDF：https://arxiv.org/pdf/2610.01963v1

> Emergency department (ED) triage is a high-stakes prioritization task in which demographic, socioeconomic, and system-context information may improperly influence acuity assignment. Although open-source **large** **language** models (LLMs) are increasingly considered for local and privacy-preserving clinical decision support, it remains unclear how counterfactual bias varies across model families, sizes, medical-domain models, and domain-adapted models. We present a comparative counterfactual audit of ten open-source LLMs for pediatric Emergency Severity Index (ESI) prediction. Starting from real and handbook-style clinical vignettes, we construct paired counterfactual variants that change …


### 10. Latent JEPA: Abstract Future Prediction for Latent **Reasoning** in Chemistry

- Xinjian Zhao, Yaoyao Xu, Xuemin Chen, Xiaozhuang Song, Tianshu Yu
- 2026-10-01 ｜ arXiv:2610.01947 ｜ cs.LG, cs.CL
- 链接：https://arxiv.org/abs/2610.01947v1 ｜ PDF：https://arxiv.org/pdf/2610.01947v1

> **Large** **language** models offer a promising foundation for chemical **reasoning**, bringing together chemical knowledge and multistep problem solving. Chemical intuition can provide an initial sense of plausible outcomes before the details of a solution are fully worked out. Inspired by how such expectations complement explicit **analysis**, we study how continuous latent thoughts can be trained to anticipate informative aspects of future solutions without verbalizing every intermediate step. We introduce Latent JEPA, a framework that combines autoregressive **learning** with joint-embedding prediction of one or more future views. For chemical **reasoning**, we develop textual and molec…


### 11. **Learning** to Predict Distributions over **Weight** **Updates** for Test-Time Adaptation

- Azal Ahmad Khan, Keshav Ramji, Tahira Naseem, Ali Anwar, Ramón Fernandez Astudillo
- 2026-10-01 ｜ arXiv:2610.01934 ｜ cs.LG
- 链接：https://arxiv.org/abs/2610.01934v1 ｜ PDF：https://arxiv.org/pdf/2610.01934v1

> Hypernetworks have recently shown success in dynamically adapting the parameters of **Large** **Language** Models (LLMs) at runtime based on signals such as task descriptions or additional demostrations. Here we ask: how much adaptation signal can be obtained using only the input query to an **LLM**?. To answer this, we study query-conditioned Hypernetworks for LoRA estimation. Further, we introduce distributional Hypernetworks, able to produce not only point estimates of parameter adaptors, but also a distribution over possible LoRAs. For this we propose a simple end-to-end loss using a differentiable Monte Carlo approximation and explore multiple distribution parametrizations including re…


### 12. Asynchronous **LLM** **Post-Training**: Group-Mass Capping and Convergence **Analysis**

- Qijia He, Ruinan Jin, Jun Luo, Shaofeng Zou, Yingbin Liang
- 2026-10-01 ｜ arXiv:2610.01896 ｜ cs.LG, cs.AI
- 备注：40 pages, 6 figures
- 链接：https://arxiv.org/abs/2610.01896v1 ｜ PDF：https://arxiv.org/pdf/2610.01896v1

> Asynchronous reinforcement **learning** (RL) improves the efficiency of **large** **language** model **post-training** but introduces stale rollouts generated by earlier policies. Theoretical understanding of how this staleness affects convergence and how to mitigate its impact remains limited. We derive a convergence bound for GRPO-style algorithms that explicitly characterizes the tradeoff between the gradient estimator's second moment and bias. For trajectory-level importance-weighted estimators, our **analysis** shows that once the second moment is uniformly controlled, delay enters the bound through the bias introduced by clipping or rescaling. Guided by this insight, we propose a nove…


---

<sub>由 PaperPilot arXiv 工具包生成 · 数据来源 arXiv API（导出/使用请遵守 arXiv 使用条款）</sub>