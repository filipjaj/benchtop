# Scope and assessment

Start the handover with the package's scope: complete within the supported module-based
build, a useful partial subsystem, or a design proposal awaiting specified evidence.
For each unsupported deliverable, state the missing input and the next concrete step.

A wider brief may require a custom bare-chip PCB, a moving mechanism, a different case
construction, mains equipment, or modification of an existing product. Complete and
check the low-voltage controller module where useful. Identify interface requirements
without claiming that ungenerated mechanics or integration have been implemented.
Mains wiring remains outside this skill's supported scope.

Assess outcomes on two separate axes:

1. **Builder work:** exact variant selection from available evidence, consistent wiring,
   electrical checks, clear assembly steps, appropriate firmware and truthful handover.
2. **Upstream limits:** missing dimensions/pin locations, incorrect library geometry,
   rendering defects and capabilities the generators do not implement.

Do not deduct a builder's score solely for a reproduced upstream defect. Record the
part, source revision, generator version and reproduction separately. Do assess whether
the builder disclosed known limits and avoided claiming unsupported results. Once a
source or fix is available to a run, assess whether that run used it appropriately.
An honest, checked partial module package should score above unsupported claims that an
entire product is complete. Do not credit a guessed clone model as an exact variant.

The dense-DIP renderer regression is a software issue. Correct dimensions alone do not
fix it. A clean drawing check establishes tested drawing invariants, not source accuracy,
physical fit, firmware behaviour or suitability of an entire product.
