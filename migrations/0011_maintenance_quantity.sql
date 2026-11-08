-- NULL preserves legacy maintenance: it stopped the entire resource.
ALTER TABLE maintenance_periods ADD COLUMN quantity INTEGER CHECK(quantity IS NULL OR quantity>0);
