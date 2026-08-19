-- 040_engagement_schedule_constraints.sql
-- Duration claims in the delivery methodology must be enforceable schedule data.

ALTER TABLE engagement_delivery_milestones
  ADD COLUMN minimum_duration_months INTEGER NOT NULL DEFAULT 0
  CHECK(minimum_duration_months >= 0 AND minimum_duration_months <= 36);

-- Three months of operating evidence is a calendar-period requirement. The
-- scheduling engine propagates this constraint through dependent work.
UPDATE engagement_delivery_milestones
SET minimum_duration_months = 3
WHERE milestone_key = 'w12-evidence';
